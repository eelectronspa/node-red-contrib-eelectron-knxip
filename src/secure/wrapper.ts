// SECURE_WRAPPER frame encryption / decryption per KNX/IP Secure §4.5.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Each session frame is a SecureWrapper body whose plaintext is a complete
// inner KNX/IP frame (header + body). The wrapper carries:
//   - sessionId          (uint16)
//   - sequenceId         (uint48 — monotonic, anti-replay)
//   - serialNumber       (uint48 — sender identity)
//   - messageTag         (uint16)
//   - encryptedPayload   (variable — same length as the plaintext frame)
//   - mac                (16 bytes — encrypted CBC-MAC)
//
// The 16-byte block_0 / counter_0 inputs are constructed from the sequence
// information, serial number, message tag, and a suffix that varies per
// purpose (payload length for block_0, `\xff\x00` for counter_0).

import { aesCbcMac, aesCtrXor } from './crypto';

const WRAPPER_HEADER_PREFIX = Buffer.from([0x06, 0x10, 0x09, 0x50]);
const WRAPPER_FIXED_OVERHEAD = 38; // 6 header + 2 session + 6 seq + 6 serial + 2 tag + 16 mac

function writeUInt48BE(buf: Buffer, value: number, offset: number): void {
  if (value < 0 || value > 0xffff_ffff_ffff) {
    throw new RangeError(`uint48 out of range: ${value}`);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value % 0x1_0000_0000;
  buf.writeUInt16BE(high, offset);
  buf.writeUInt32BE(low, offset + 2);
}

function uint48ToBE(value: number): Buffer {
  const b = Buffer.alloc(6);
  writeUInt48BE(b, value, 0);
  return b;
}

function uint16ToBE(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

interface WrapperBlocks {
  /** 16-byte block_0 used for the CBC-MAC. */
  block0: Buffer;
  /** 16-byte counter_0 used to AES-CTR-encrypt MAC + payload. */
  counter0: Buffer;
  /** wrapper_header (6 bytes) + session_id (2 bytes) used as MAC additional data. */
  additionalData: Buffer;
}

function buildBlocks(args: {
  sessionId: number;
  sequenceId: number;
  serialNumber: number;
  messageTag: number;
  payloadLength: number;
}): WrapperBlocks {
  const seq = uint48ToBE(args.sequenceId);
  const serial = uint48ToBE(args.serialNumber);
  const tag = uint16ToBE(args.messageTag);

  const block0 = Buffer.concat([seq, serial, tag, uint16ToBE(args.payloadLength)]);
  const counter0 = Buffer.concat([seq, serial, tag, Buffer.from([0xff, 0x00])]);

  const totalLength = WRAPPER_FIXED_OVERHEAD + args.payloadLength;
  const wrapperHeader = Buffer.concat([WRAPPER_HEADER_PREFIX, uint16ToBE(totalLength)]);
  const additionalData = Buffer.concat([wrapperHeader, uint16ToBE(args.sessionId)]);

  return { block0, counter0, additionalData };
}

export interface EncryptWrapperInput {
  sessionKey: Buffer;
  sessionId: number;
  sequenceId: number;
  serialNumber: number;
  messageTag: number;
  /** Full plaintext KNX/IP frame (header + body), as `KNXIPFrame.toKnx()` produces. */
  plainFrame: Buffer;
}

export interface EncryptWrapperOutput {
  /** Ciphertext, same length as the plaintext frame. */
  encryptedFrame: Buffer;
  /** 16-byte MAC, encrypted under counter_0 — drop directly into SecureWrapper.mac. */
  mac: Buffer;
}

export function encryptSecureWrapper(opts: EncryptWrapperInput): EncryptWrapperOutput {
  const { block0, counter0, additionalData } = buildBlocks({
    sessionId: opts.sessionId,
    sequenceId: opts.sequenceId,
    serialNumber: opts.serialNumber,
    messageTag: opts.messageTag,
    payloadLength: opts.plainFrame.length,
  });

  const macCbc = aesCbcMac({
    key: opts.sessionKey,
    additionalData,
    payload: opts.plainFrame,
    block0,
  });

  // The wire MAC is encrypted with the keystream block at counter_0; the
  // payload picks up at counter_0 + 1, ..., handled by passing one CTR cipher
  // both blocks of input.
  const stream = aesCtrXor(
    opts.sessionKey,
    counter0,
    Buffer.concat([macCbc, opts.plainFrame]),
  );
  return {
    mac: stream.subarray(0, 16),
    encryptedFrame: stream.subarray(16),
  };
}

export interface DecryptWrapperInput {
  sessionKey: Buffer;
  sessionId: number;
  sequenceId: number;
  serialNumber: number;
  messageTag: number;
  encryptedFrame: Buffer;
  mac: Buffer;
}

/** Decrypt + verify. Throws on MAC mismatch. */
export function decryptSecureWrapper(opts: DecryptWrapperInput): Buffer {
  if (opts.mac.length !== 16) {
    throw new RangeError(`SecureWrapper MAC must be 16 bytes (got ${opts.mac.length})`);
  }
  const { block0, counter0, additionalData } = buildBlocks({
    sessionId: opts.sessionId,
    sequenceId: opts.sequenceId,
    serialNumber: opts.serialNumber,
    messageTag: opts.messageTag,
    payloadLength: opts.encryptedFrame.length,
  });

  // Symmetric: re-running CTR over the wire bytes recovers (CBC-MAC || plain)
  const stream = aesCtrXor(
    opts.sessionKey,
    counter0,
    Buffer.concat([opts.mac, opts.encryptedFrame]),
  );
  const recoveredMac = stream.subarray(0, 16);
  const plainFrame = stream.subarray(16);

  const expectedMac = aesCbcMac({
    key: opts.sessionKey,
    additionalData,
    payload: plainFrame,
    block0,
  });

  if (!recoveredMac.equals(expectedMac)) {
    throw new Error('SECURE_WRAPPER MAC verification failed');
  }
  return plainFrame;
}

// SECURE_WRAPPER (0x0950) — outer envelope for every authenticated KNX/IP
// frame in a Secure Tunneling / Secure Routing session.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Wire layout (all big-endian):
//   [0..1]   Secure Session Identifier (uint16)
//   [2..7]   Sequence Identifier (uint48) — monotonic anti-replay counter
//   [8..13]  Serial Number (uint48) — sender identity
//   [14..15] Message Tag (uint16)
//   [16..16+n)  Encrypted KNX/IP frame (variable)
//   [16+n..32+n)  Message Authentication Code (16 bytes, AES-128-CMAC)
//
// This module handles the container only — the encrypted payload and MAC are
// opaque bytes here. Decryption / verification happens in a separate crypto
// layer (next turn).

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';

export const SECURE_WRAPPER_HEADER_LEN = 16;
export const SECURE_WRAPPER_MAC_LEN = 16;
export const SECURE_WRAPPER_OVERHEAD = SECURE_WRAPPER_HEADER_LEN + SECURE_WRAPPER_MAC_LEN;

export interface SecureWrapperInit {
  sessionId: number;
  /** uint48 anti-replay counter — pass as a JS number (52-bit safe range). */
  sequenceId: number;
  /** uint48 sender serial number. */
  serialNumber: number;
  messageTag: number;
  /** Encrypted KNX/IP frame (the inner header + body, ciphertext form). */
  encryptedFrame: Buffer;
  /** AES-128-CMAC, 16 bytes. */
  mac: Buffer;
}

function writeUInt48BE(buf: Buffer, value: number, offset: number): void {
  if (value < 0 || value > 0xffff_ffff_ffff) {
    throw new RangeError(`uint48 out of range: ${value}`);
  }
  // Split into high 16 bits and low 32 bits to dodge the 32-bit limit on writeUInt*.
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value % 0x1_0000_0000;
  buf.writeUInt16BE(high, offset);
  buf.writeUInt32BE(low, offset + 2);
}

function readUInt48BE(buf: Buffer, offset: number): number {
  const high = buf.readUInt16BE(offset);
  const low = buf.readUInt32BE(offset + 2);
  return high * 0x1_0000_0000 + low;
}

export class SecureWrapper {
  static readonly SERVICE_TYPE = ServiceType.SECURE_WRAPPER;

  sessionId: number;
  sequenceId: number;
  serialNumber: number;
  messageTag: number;
  encryptedFrame: Buffer;
  mac: Buffer;

  constructor(init: SecureWrapperInit) {
    if (init.mac.length !== SECURE_WRAPPER_MAC_LEN) {
      throw new RangeError(`SECURE_WRAPPER MAC must be ${SECURE_WRAPPER_MAC_LEN} bytes`);
    }
    this.sessionId = init.sessionId;
    this.sequenceId = init.sequenceId;
    this.serialNumber = init.serialNumber;
    this.messageTag = init.messageTag;
    this.encryptedFrame = init.encryptedFrame;
    this.mac = init.mac;
  }

  calculatedLength(): number {
    return SECURE_WRAPPER_OVERHEAD + this.encryptedFrame.length;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SecureWrapper; bytesRead: number } {
    const available = raw.length - offset;
    if (available < SECURE_WRAPPER_OVERHEAD) {
      throw new CouldNotParseKNXIP('SECURE_WRAPPER too short for header + MAC');
    }
    const sessionId = raw.readUInt16BE(offset);
    const sequenceId = readUInt48BE(raw, offset + 2);
    const serialNumber = readUInt48BE(raw, offset + 8);
    const messageTag = raw.readUInt16BE(offset + 14);
    const innerLen = available - SECURE_WRAPPER_OVERHEAD;
    const encryptedFrame = Buffer.from(
      raw.subarray(offset + SECURE_WRAPPER_HEADER_LEN, offset + SECURE_WRAPPER_HEADER_LEN + innerLen),
    );
    const mac = Buffer.from(
      raw.subarray(
        offset + SECURE_WRAPPER_HEADER_LEN + innerLen,
        offset + SECURE_WRAPPER_HEADER_LEN + innerLen + SECURE_WRAPPER_MAC_LEN,
      ),
    );
    return {
      body: new SecureWrapper({
        sessionId,
        sequenceId,
        serialNumber,
        messageTag,
        encryptedFrame,
        mac,
      }),
      bytesRead: SECURE_WRAPPER_OVERHEAD + innerLen,
    };
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(this.calculatedLength());
    out.writeUInt16BE(this.sessionId, 0);
    writeUInt48BE(out, this.sequenceId, 2);
    writeUInt48BE(out, this.serialNumber, 8);
    out.writeUInt16BE(this.messageTag, 14);
    this.encryptedFrame.copy(out, SECURE_WRAPPER_HEADER_LEN);
    this.mac.copy(out, SECURE_WRAPPER_HEADER_LEN + this.encryptedFrame.length);
    return out;
  }
}

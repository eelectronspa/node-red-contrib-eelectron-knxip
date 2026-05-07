// KNX/IP Secure handshake MAC helpers.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// The handshake MAC is computed as a KNX-flavoured CBC-MAC and then encrypted
// with AES-CTR using a fixed 16-byte counter (`COUNTER_0_HANDSHAKE`). The
// encryption is symmetric, so the same operation verifies an incoming MAC
// (decrypt → compare against locally-recomputed CBC-MAC) and prepares an
// outgoing one (encrypt → put on the wire).
//
// Header bytes are baked into the MAC inputs because the receiver needs to
// know exactly which service type / total length the sender claimed; that's
// why the additional-data starts with the literal KNX/IP header bytes.

import { aesCbcMac, aesCtrXor, bytesXor } from './crypto';

/** Fixed 16-byte initial counter for handshake CTR encryption. */
export const COUNTER_0_HANDSHAKE = Buffer.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0xff, 0,
]);

const SESSION_RESPONSE_HEADER = Buffer.from([0x06, 0x10, 0x09, 0x52, 0x00, 0x38]);
const SESSION_AUTHENTICATE_HEADER = Buffer.from([0x06, 0x10, 0x09, 0x53, 0x00, 0x18]);

const PUBKEY_LEN = 32;

function checkPubKey(name: string, b: Buffer): void {
  if (b.length !== PUBKEY_LEN) {
    throw new RangeError(`${name} must be ${PUBKEY_LEN} bytes (got ${b.length})`);
  }
}

/**
 * Compute the expected MAC for a SESSION_RESPONSE (server → client).
 *
 * Inputs:
 *   - deviceAuthCode: 16-byte derived device auth code
 *   - sessionId:      uint16 from the response
 *   - clientPublicKey, serverPublicKey: raw 32-byte X25519 keys
 *
 * Returns the encrypted-on-the-wire MAC. Compare for equality against the
 * MAC the server sent.
 */
export function computeSessionResponseMac(opts: {
  deviceAuthCode: Buffer;
  sessionId: number;
  clientPublicKey: Buffer;
  serverPublicKey: Buffer;
}): Buffer {
  checkPubKey('clientPublicKey', opts.clientPublicKey);
  checkPubKey('serverPublicKey', opts.serverPublicKey);
  const sessionIdBE = Buffer.alloc(2);
  sessionIdBE.writeUInt16BE(opts.sessionId, 0);
  const pubXor = bytesXor(opts.clientPublicKey, opts.serverPublicKey);

  const mac = aesCbcMac({
    key: opts.deviceAuthCode,
    additionalData: Buffer.concat([SESSION_RESPONSE_HEADER, sessionIdBE, pubXor]),
  });
  return aesCtrXor(opts.deviceAuthCode, COUNTER_0_HANDSHAKE, mac);
}

/**
 * Compute the MAC the client sends in a SESSION_AUTHENTICATE.
 *
 *   block_0           = 16 zero bytes
 *   additionalData    = 0x06 0x10 0x09 0x53 0x00 0x18 || 0x00 || userId || (clientPub XOR serverPub)
 *   payload           = empty
 *   key               = userPasswordKey
 *
 * The CBC-MAC is then encrypted with AES-CTR(COUNTER_0_HANDSHAKE).
 */
export function computeAuthenticateMac(opts: {
  userPasswordKey: Buffer;
  userId: number;
  clientPublicKey: Buffer;
  serverPublicKey: Buffer;
}): Buffer {
  checkPubKey('clientPublicKey', opts.clientPublicKey);
  checkPubKey('serverPublicKey', opts.serverPublicKey);
  if (!Number.isInteger(opts.userId) || opts.userId < 1 || opts.userId > 127) {
    throw new RangeError(`userId must be 1..127 (got ${opts.userId})`);
  }
  const pubXor = bytesXor(opts.clientPublicKey, opts.serverPublicKey);

  const mac = aesCbcMac({
    key: opts.userPasswordKey,
    additionalData: Buffer.concat([
      SESSION_AUTHENTICATE_HEADER,
      Buffer.from([0x00, opts.userId & 0x7f]), // reserved + user id
      pubXor,
    ]),
  });
  return aesCtrXor(opts.userPasswordKey, COUNTER_0_HANDSHAKE, mac);
}

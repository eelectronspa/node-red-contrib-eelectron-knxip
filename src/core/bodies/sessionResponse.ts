// SESSION_RESPONSE (0x0952) — server's reply to SESSION_REQUEST.
//
// Wire layout:
//   [0..1]    Secure Session Identifier (uint16) — assigned by the server
//   [2..33]   Server X25519 public value (32 bytes)
//   [34..49]  Message Authentication Code (16 bytes, AES-128-CMAC)
//
// MAC covers the header + session ID + concatenated public keys, keyed with
// the device authentication code. Verification happens in the secure layer.

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';
import { X25519_PUBLIC_KEY_LEN } from './sessionRequest';

export const SECURE_MAC_LEN = 16;

export interface SessionResponseInit {
  sessionId: number;
  publicKey: Buffer;
  mac: Buffer;
}

export class SessionResponse {
  static readonly SERVICE_TYPE = ServiceType.SESSION_RESPONSE;

  sessionId: number;
  publicKey: Buffer;
  mac: Buffer;

  constructor(init: SessionResponseInit) {
    if (init.publicKey.length !== X25519_PUBLIC_KEY_LEN) {
      throw new RangeError(`SESSION_RESPONSE publicKey must be ${X25519_PUBLIC_KEY_LEN} bytes`);
    }
    if (init.mac.length !== SECURE_MAC_LEN) {
      throw new RangeError(`SESSION_RESPONSE MAC must be ${SECURE_MAC_LEN} bytes`);
    }
    this.sessionId = init.sessionId;
    this.publicKey = init.publicKey;
    this.mac = init.mac;
  }

  calculatedLength(): number {
    return 2 + X25519_PUBLIC_KEY_LEN + SECURE_MAC_LEN;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SessionResponse; bytesRead: number } {
    const total = 2 + X25519_PUBLIC_KEY_LEN + SECURE_MAC_LEN;
    if (raw.length - offset < total) {
      throw new CouldNotParseKNXIP('SESSION_RESPONSE too short');
    }
    const sessionId = raw.readUInt16BE(offset);
    const publicKey = Buffer.from(
      raw.subarray(offset + 2, offset + 2 + X25519_PUBLIC_KEY_LEN),
    );
    const mac = Buffer.from(
      raw.subarray(
        offset + 2 + X25519_PUBLIC_KEY_LEN,
        offset + 2 + X25519_PUBLIC_KEY_LEN + SECURE_MAC_LEN,
      ),
    );
    return {
      body: new SessionResponse({ sessionId, publicKey, mac }),
      bytesRead: total,
    };
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(this.calculatedLength());
    out.writeUInt16BE(this.sessionId, 0);
    this.publicKey.copy(out, 2);
    this.mac.copy(out, 2 + X25519_PUBLIC_KEY_LEN);
    return out;
  }
}

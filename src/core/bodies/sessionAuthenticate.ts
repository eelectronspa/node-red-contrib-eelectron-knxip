// SESSION_AUTHENTICATE (0x0953) — client proves knowledge of the user
// password to complete the secure handshake.
//
// Wire layout:
//   [0]       Reserved (0x00)
//   [1]       User ID (1..127; 1 = management, others = configured users)
//   [2..17]   Message Authentication Code (16 bytes, AES-128-CMAC)
//
// MAC covers the header + reserved + user ID + concatenated public keys,
// keyed with the user's password hash. Verified server-side.

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';
import { SECURE_MAC_LEN } from './sessionResponse';

export interface SessionAuthenticateInit {
  userId: number;
  mac: Buffer;
}

export class SessionAuthenticate {
  static readonly SERVICE_TYPE = ServiceType.SESSION_AUTHENTICATE;
  static readonly LENGTH = 2 + SECURE_MAC_LEN;

  userId: number;
  mac: Buffer;

  constructor(init: SessionAuthenticateInit) {
    if (!Number.isInteger(init.userId) || init.userId < 1 || init.userId > 127) {
      throw new RangeError(`SESSION_AUTHENTICATE user ID out of range (1..127): ${init.userId}`);
    }
    if (init.mac.length !== SECURE_MAC_LEN) {
      throw new RangeError(`SESSION_AUTHENTICATE MAC must be ${SECURE_MAC_LEN} bytes`);
    }
    this.userId = init.userId;
    this.mac = init.mac;
  }

  calculatedLength(): number {
    return SessionAuthenticate.LENGTH;
  }

  static fromKnx(
    raw: Buffer,
    offset = 0,
  ): { body: SessionAuthenticate; bytesRead: number } {
    if (raw.length - offset < SessionAuthenticate.LENGTH) {
      throw new CouldNotParseKNXIP('SESSION_AUTHENTICATE too short');
    }
    // raw[offset] is reserved (0x00); we don't validate, but we don't include it
    const userId = raw[offset + 1]!;
    const mac = Buffer.from(raw.subarray(offset + 2, offset + 2 + SECURE_MAC_LEN));
    return {
      body: new SessionAuthenticate({ userId, mac }),
      bytesRead: SessionAuthenticate.LENGTH,
    };
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(SessionAuthenticate.LENGTH);
    out[0] = 0x00; // reserved
    out[1] = this.userId;
    this.mac.copy(out, 2);
    return out;
  }
}

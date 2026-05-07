// SESSION_REQUEST (0x0951) — first message of the KNX/IP Secure handshake.
//
// Wire layout:
//   [0..7]    HPAI control endpoint (8 bytes)
//   [8..39]   Client X25519 public value (32 bytes)

import { CouldNotParseKNXIP } from '../errors';
import { HPAI } from '../hpai';
import { HostProtocol, ServiceType } from '../serviceTypes';

export const X25519_PUBLIC_KEY_LEN = 32;

export interface SessionRequestInit {
  controlEndpoint?: HPAI;
  publicKey: Buffer;
}

export class SessionRequest {
  static readonly SERVICE_TYPE = ServiceType.SESSION_REQUEST;

  controlEndpoint: HPAI;
  publicKey: Buffer;

  constructor(init: SessionRequestInit) {
    if (init.publicKey.length !== X25519_PUBLIC_KEY_LEN) {
      throw new RangeError(`SESSION_REQUEST publicKey must be ${X25519_PUBLIC_KEY_LEN} bytes`);
    }
    // SESSION_REQUEST is only sent over TCP (KNX/IP Secure §2.5.4), so the
    // HPAI must declare the TCP host protocol — many gateways silently drop
    // a SESSION_REQUEST whose HPAI says UDP.
    this.controlEndpoint =
      init.controlEndpoint ?? HPAI.routeBack(HostProtocol.IPV4_TCP);
    this.publicKey = init.publicKey;
  }

  calculatedLength(): number {
    return HPAI.LENGTH + X25519_PUBLIC_KEY_LEN;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SessionRequest; bytesRead: number } {
    if (raw.length - offset < HPAI.LENGTH + X25519_PUBLIC_KEY_LEN) {
      throw new CouldNotParseKNXIP('SESSION_REQUEST too short');
    }
    const { hpai, bytesRead: hpaiBytes } = HPAI.fromKnx(raw, offset);
    const publicKey = Buffer.from(
      raw.subarray(offset + hpaiBytes, offset + hpaiBytes + X25519_PUBLIC_KEY_LEN),
    );
    return {
      body: new SessionRequest({ controlEndpoint: hpai, publicKey }),
      bytesRead: hpaiBytes + X25519_PUBLIC_KEY_LEN,
    };
  }

  toKnx(): Buffer {
    return Buffer.concat([this.controlEndpoint.toKnx(), this.publicKey]);
  }
}

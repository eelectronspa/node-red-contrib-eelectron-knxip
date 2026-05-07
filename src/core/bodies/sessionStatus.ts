// SESSION_STATUS (0x0954) — short notification messages exchanged across the
// life of a secure session.
//
// Wire layout: a single status byte.

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';

export const SecureSessionStatus = {
  AUTHENTICATION_SUCCESS: 0x00,
  AUTHENTICATION_FAILED: 0x01,
  UNAUTHENTICATED: 0x02,
  TIMEOUT: 0x03,
  KEEPALIVE: 0x04,
  CLOSE: 0x05,
} as const;

export type SecureSessionStatus =
  (typeof SecureSessionStatus)[keyof typeof SecureSessionStatus];

const STATUS_NAMES = Object.fromEntries(
  Object.entries(SecureSessionStatus).map(([k, v]) => [v, k]),
) as Record<number, string>;

export function secureSessionStatusName(code: number): string {
  return STATUS_NAMES[code] ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`;
}

export interface SessionStatusInit {
  status: SecureSessionStatus | number;
}

export class SessionStatus {
  static readonly SERVICE_TYPE = ServiceType.SESSION_STATUS;
  static readonly LENGTH = 1;

  status: number;

  constructor(init: SessionStatusInit) {
    this.status = init.status;
  }

  calculatedLength(): number {
    return SessionStatus.LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SessionStatus; bytesRead: number } {
    if (raw.length - offset < 1) {
      throw new CouldNotParseKNXIP('SESSION_STATUS too short');
    }
    return {
      body: new SessionStatus({ status: raw[offset]! }),
      bytesRead: 1,
    };
  }

  toKnx(): Buffer {
    return Buffer.from([this.status & 0xff]);
  }
}

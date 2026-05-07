// TIMER_NOTIFY (0x0955) — Secure Routing time-synchronisation message.
//
// Wire layout:
//   [0..5]   Timer value (uint48 BE) — sender's monotonic timer
//   [6..11]  Serial Number (uint48 BE)
//   [12..13] Message Tag (uint16)
//   [14..29] Message Authentication Code (16 bytes)

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';
import { SECURE_MAC_LEN } from './sessionResponse';

const TIMER_NOTIFY_LEN = 6 + 6 + 2 + SECURE_MAC_LEN;

function readUInt48BE(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset) * 0x1_0000_0000 + buf.readUInt32BE(offset + 2);
}

function writeUInt48BE(buf: Buffer, value: number, offset: number): void {
  if (value < 0 || value > 0xffff_ffff_ffff) {
    throw new RangeError(`uint48 out of range: ${value}`);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value % 0x1_0000_0000;
  buf.writeUInt16BE(high, offset);
  buf.writeUInt32BE(low, offset + 2);
}

export interface TimerNotifyInit {
  timer: number;
  serialNumber: number;
  messageTag: number;
  mac: Buffer;
}

export class TimerNotify {
  static readonly SERVICE_TYPE = ServiceType.TIMER_NOTIFY;
  static readonly LENGTH = TIMER_NOTIFY_LEN;

  timer: number;
  serialNumber: number;
  messageTag: number;
  mac: Buffer;

  constructor(init: TimerNotifyInit) {
    if (init.mac.length !== SECURE_MAC_LEN) {
      throw new RangeError(`TIMER_NOTIFY MAC must be ${SECURE_MAC_LEN} bytes`);
    }
    this.timer = init.timer;
    this.serialNumber = init.serialNumber;
    this.messageTag = init.messageTag;
    this.mac = init.mac;
  }

  calculatedLength(): number {
    return TIMER_NOTIFY_LEN;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: TimerNotify; bytesRead: number } {
    if (raw.length - offset < TIMER_NOTIFY_LEN) {
      throw new CouldNotParseKNXIP('TIMER_NOTIFY too short');
    }
    const timer = readUInt48BE(raw, offset);
    const serialNumber = readUInt48BE(raw, offset + 6);
    const messageTag = raw.readUInt16BE(offset + 12);
    const mac = Buffer.from(raw.subarray(offset + 14, offset + 14 + SECURE_MAC_LEN));
    return {
      body: new TimerNotify({ timer, serialNumber, messageTag, mac }),
      bytesRead: TIMER_NOTIFY_LEN,
    };
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(TIMER_NOTIFY_LEN);
    writeUInt48BE(out, this.timer, 0);
    writeUInt48BE(out, this.serialNumber, 6);
    out.writeUInt16BE(this.messageTag, 12);
    this.mac.copy(out, 14);
    return out;
  }
}

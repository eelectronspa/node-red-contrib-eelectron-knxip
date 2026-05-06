// DPT 19.001 — Date + Time. 8 bytes:
//   [0] year offset from 1900 (0..255 → 1900..2155)
//   [1] month (low 4 bits, 1..12)
//   [2] day-of-month (low 5 bits, 1..31)
//   [3] day-of-week (high 3 bits, 0=any, 1=Mon..7=Sun) | hour (low 5 bits, 0..23 or 24=any)
//   [4] minutes (low 6 bits, 0..59)
//   [5] seconds (low 6 bits, 0..59)
//   [6] flags: bit7 fault, bit6 working_day, bit5 nwd valid, bit4 no_year,
//              bit3 no_date, bit2 no_dow, bit1 no_time, bit0 summer_time
//   [7] bit7 quality (1 = unsynchronised), lower bits reserved

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export type KNXDay =
  | 'any'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

const DAY_NAMES: KNXDay[] = [
  'any',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const DAY_INDEX = new Map<KNXDay, number>(DAY_NAMES.map((n, i) => [n, i]));

export interface DPT19Value {
  year: number;
  month: number;
  day: number;
  hour: number;
  minutes: number;
  seconds: number;
  dayOfWeek?: KNXDay;
  fault?: boolean;
  workingDay?: boolean;
  workingDayValid?: boolean;
  summerTime?: boolean;
  clockQuality?: 'synchronised' | 'unsynchronised';
}

const codec: DPTCodec<DPT19Value> = {
  id: '19.001',
  name: 'datetime',
  decode(apdu): DPT19Value {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 8) {
      throw new ConversionError('DPT 19.001: expected 8-byte APDU');
    }
    const b = apdu.value;
    const year = 1900 + b[0]!;
    const month = b[1]! & 0x0f;
    const day = b[2]! & 0x1f;
    const dow = (b[3]! >> 5) & 0x07;
    const hour = b[3]! & 0x1f;
    const minutes = b[4]! & 0x3f;
    const seconds = b[5]! & 0x3f;
    const flags = b[6]!;
    const quality = b[7]!;
    return {
      year,
      month,
      day,
      hour,
      minutes,
      seconds,
      dayOfWeek: DAY_NAMES[dow] ?? 'any',
      fault: (flags & 0x80) !== 0,
      workingDayValid: (flags & 0x20) !== 0,
      workingDay: (flags & 0x40) !== 0,
      summerTime: (flags & 0x01) !== 0,
      clockQuality: (quality & 0x80) !== 0 ? 'unsynchronised' : 'synchronised',
    };
  },
  encode(v: DPT19Value): APDUValue {
    if (v.year < 1900 || v.year > 2155) {
      throw new ConversionError(`DPT 19.001: year out of range (1900..2155): ${v.year}`);
    }
    if (v.month < 1 || v.month > 12) {
      throw new ConversionError(`DPT 19.001: month out of range (1..12): ${v.month}`);
    }
    if (v.day < 1 || v.day > 31) {
      throw new ConversionError(`DPT 19.001: day out of range (1..31): ${v.day}`);
    }
    if (v.hour < 0 || v.hour > 24) {
      throw new ConversionError(`DPT 19.001: hour out of range (0..24): ${v.hour}`);
    }
    if (v.minutes < 0 || v.minutes > 59) {
      throw new ConversionError(`DPT 19.001: minutes out of range (0..59): ${v.minutes}`);
    }
    if (v.seconds < 0 || v.seconds > 59) {
      throw new ConversionError(`DPT 19.001: seconds out of range (0..59): ${v.seconds}`);
    }
    const dow = DAY_INDEX.get(v.dayOfWeek ?? 'any') ?? 0;
    let flags = 0;
    if (v.fault) flags |= 0x80;
    if (v.workingDay) flags |= 0x40;
    if (v.workingDayValid) flags |= 0x20;
    if (v.summerTime) flags |= 0x01;
    const quality = v.clockQuality === 'unsynchronised' ? 0x80 : 0x00;
    return {
      kind: 'bytes',
      value: Buffer.from([
        v.year - 1900,
        v.month & 0x0f,
        v.day & 0x1f,
        ((dow & 0x07) << 5) | (v.hour & 0x1f),
        v.minutes & 0x3f,
        v.seconds & 0x3f,
        flags,
        quality,
      ]),
    };
  },
};

registerDpt(codec);

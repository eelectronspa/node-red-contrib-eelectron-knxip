// DPT 10.001 — Time of day. 3 bytes:
//   [0] day-of-week (3 bits, 0=NO_DAY..7=SUNDAY) | hour (5 bits, 0..23)
//   [1] minutes (6 bits, 0..59)
//   [2] seconds (6 bits, 0..59)
//
// Day mapping: 0 = no day, 1 = Monday ... 7 = Sunday (KNX convention).

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export type KNXDay =
  | 'no_day'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export interface DPT10Value {
  hour: number;
  minutes: number;
  seconds: number;
  day?: KNXDay;
}

const DAY_NAMES: KNXDay[] = [
  'no_day',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const DAY_INDEX = new Map<KNXDay, number>(DAY_NAMES.map((name, i) => [name, i]));

const codec: DPTCodec<DPT10Value> = {
  id: '10.001',
  name: 'time',
  decode(apdu): DPT10Value {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 3) {
      throw new ConversionError('DPT 10.001: expected 3-byte APDU');
    }
    const dayBits = (apdu.value[0]! & 0xe0) >> 5;
    const hour = apdu.value[0]! & 0x1f;
    const minutes = apdu.value[1]! & 0x3f;
    const seconds = apdu.value[2]! & 0x3f;
    return { hour, minutes, seconds, day: DAY_NAMES[dayBits] ?? 'no_day' };
  },
  encode(v: DPT10Value): APDUValue {
    if (v.hour < 0 || v.hour > 23) {
      throw new ConversionError(`DPT 10.001: hour out of range (0..23): ${v.hour}`);
    }
    if (v.minutes < 0 || v.minutes > 59) {
      throw new ConversionError(`DPT 10.001: minutes out of range (0..59): ${v.minutes}`);
    }
    if (v.seconds < 0 || v.seconds > 59) {
      throw new ConversionError(`DPT 10.001: seconds out of range (0..59): ${v.seconds}`);
    }
    const dayIdx = DAY_INDEX.get(v.day ?? 'no_day') ?? 0;
    return {
      kind: 'bytes',
      value: Buffer.from([(dayIdx << 5) | v.hour, v.minutes, v.seconds]),
    };
  },
};

registerDpt(codec);

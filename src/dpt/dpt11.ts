// DPT 11.001 — Date. 3 bytes:
//   [0] day (5 bits, 1..31)
//   [1] month (4 bits, 1..12)
//   [2] year (7 bits): 0..89 → 2000..2089, 90..99 → 1990..1999

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface DPT11Value {
  year: number;
  month: number;
  day: number;
}

const codec: DPTCodec<DPT11Value> = {
  id: '11.001',
  name: 'date',
  decode(apdu): DPT11Value {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 3) {
      throw new ConversionError('DPT 11.001: expected 3-byte APDU');
    }
    const day = apdu.value[0]! & 0x1f;
    const month = apdu.value[1]! & 0x0f;
    const yearShort = apdu.value[2]! & 0x7f;
    const year = yearShort >= 90 ? 1900 + yearShort : 2000 + yearShort;
    if (day < 1 || day > 31 || month < 1 || month > 12) {
      throw new ConversionError(
        `DPT 11.001: invalid date ${year}-${month}-${day}`,
      );
    }
    return { year, month, day };
  },
  encode(v: DPT11Value): APDUValue {
    if (v.day < 1 || v.day > 31) {
      throw new ConversionError(`DPT 11.001: day out of range (1..31): ${v.day}`);
    }
    if (v.month < 1 || v.month > 12) {
      throw new ConversionError(`DPT 11.001: month out of range (1..12): ${v.month}`);
    }
    let yearShort: number;
    if (v.year >= 2000 && v.year < 2090) yearShort = v.year - 2000;
    else if (v.year >= 1990 && v.year < 2000) yearShort = v.year - 1900;
    else
      throw new ConversionError(
        `DPT 11.001: year must be 1990..2089, got ${v.year}`,
      );
    return { kind: 'bytes', value: Buffer.from([v.day, v.month, yearShort]) };
  },
};

registerDpt(codec);

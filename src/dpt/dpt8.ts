// DPT 8.* — signed 16-bit integer. Range -32768..32767.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function readInt16(apdu: APDUValue, id: string): number {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 2) {
    throw new ConversionError(`DPT ${id}: expected 2-byte APDU`);
  }
  return apdu.value.readInt16BE(0);
}

function makeInt16(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readInt16(apdu, id),
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
        throw new ConversionError(
          `DPT ${id}: value must be integer -32768..32767, got ${value}`,
        );
      }
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(value, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeInt16('8.001', 'value_2_count'));
registerDpt(makeInt16('8.002', 'delta_time_ms', 'ms'));
registerDpt(makeInt16('8.003', 'delta_time_10ms', '10ms'));
registerDpt(makeInt16('8.004', 'delta_time_100ms', '100ms'));
registerDpt(makeInt16('8.005', 'delta_time_sec', 's'));
registerDpt(makeInt16('8.006', 'delta_time_min', 'min'));
registerDpt(makeInt16('8.007', 'delta_time_hrs', 'h'));
registerDpt(makeInt16('8.010', 'percent_v16', '%'));
registerDpt(makeInt16('8.011', 'rotation_angle', '°'));
registerDpt(makeInt16('8.012', 'length_m', 'm'));

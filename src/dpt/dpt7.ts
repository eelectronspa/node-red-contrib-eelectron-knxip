// DPT 7.* — unsigned 16-bit integer. Range 0..65535.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function readUint16(apdu: APDUValue, id: string): number {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 2) {
    throw new ConversionError(`DPT ${id}: expected 2-byte APDU`);
  }
  return apdu.value.readUInt16BE(0);
}

function makeUint16(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readUint16(apdu, id),
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new ConversionError(`DPT ${id}: value must be integer 0..65535, got ${value}`);
      }
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(value, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeUint16('7.001', 'value_2_ucount'));
registerDpt(makeUint16('7.002', 'time_period_ms', 'ms'));
registerDpt(makeUint16('7.003', 'time_period_10ms', '10ms'));
registerDpt(makeUint16('7.004', 'time_period_100ms', '100ms'));
registerDpt(makeUint16('7.005', 'time_period_sec', 's'));
registerDpt(makeUint16('7.006', 'time_period_min', 'min'));
registerDpt(makeUint16('7.007', 'time_period_hrs', 'h'));
registerDpt(makeUint16('7.011', 'length_mm', 'mm'));
registerDpt(makeUint16('7.012', 'electric_current_ma', 'mA'));
registerDpt(makeUint16('7.013', 'brightness', 'lx'));
registerDpt(makeUint16('7.600', 'absolute_colour_temperature', 'K'));

// DPT 12.* — unsigned 32-bit integer. Range 0..4_294_967_295.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function readUint32(apdu: APDUValue, id: string): number {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 4) {
    throw new ConversionError(`DPT ${id}: expected 4-byte APDU`);
  }
  return apdu.value.readUInt32BE(0);
}

function makeUint32(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readUint32(apdu, id),
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new ConversionError(
          `DPT ${id}: value must be integer 0..4294967295, got ${value}`,
        );
      }
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(value, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeUint32('12.001', 'value_4_ucount'));
registerDpt(makeUint32('12.100', 'long_time_period_sec', 's'));
registerDpt(makeUint32('12.101', 'long_time_period_min', 'min'));
registerDpt(makeUint32('12.102', 'long_time_period_hrs', 'h'));
registerDpt(makeUint32('12.1200', 'volume_liquid_litre', 'l'));
registerDpt(makeUint32('12.1201', 'volume_m3', 'm³'));

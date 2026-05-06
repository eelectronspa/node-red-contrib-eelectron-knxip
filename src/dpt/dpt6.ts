// DPT 6.* — signed 8-bit integer. Range -128..127.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function readByte(apdu: APDUValue, id: string): number {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
    throw new ConversionError(`DPT ${id}: expected 1-byte APDU`);
  }
  const raw = apdu.value[0]!;
  return raw > 127 ? raw - 256 : raw;
}

function makeSigned8(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readByte(apdu, id),
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < -128 || value > 127) {
        throw new ConversionError(`DPT ${id}: value must be integer -128..127, got ${value}`);
      }
      const raw = value < 0 ? value + 256 : value;
      return { kind: 'bytes', value: Buffer.from([raw]) };
    },
  };
}

registerDpt(makeSigned8('6.001', 'percent_v8', '%'));
registerDpt(makeSigned8('6.010', 'value_1_count'));

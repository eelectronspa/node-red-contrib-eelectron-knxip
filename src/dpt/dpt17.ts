// DPT 17.001 — Scene number (0..63 in low 6 bits of one byte).

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

const codec: DPTCodec<number> = {
  id: '17.001',
  name: 'scene_number',
  decode(apdu): number {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
      throw new ConversionError('DPT 17.001: expected 1-byte APDU');
    }
    return apdu.value[0]! & 0x3f;
  },
  encode(value: number): APDUValue {
    if (!Number.isInteger(value) || value < 0 || value > 63) {
      throw new ConversionError(
        `DPT 17.001: scene number must be 0..63, got ${value}`,
      );
    }
    return { kind: 'bytes', value: Buffer.from([value & 0x3f]) };
  },
};

registerDpt(codec);

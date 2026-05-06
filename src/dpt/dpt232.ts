// DPT 232.600 — RGB color (3 bytes, 0..255 each).

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface RGBColor {
  red: number;
  green: number;
  blue: number;
}

const codec: DPTCodec<RGBColor> = {
  id: '232.600',
  name: 'color_rgb',
  decode(apdu): RGBColor {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 3) {
      throw new ConversionError('DPT 232.600: expected 3-byte APDU');
    }
    return {
      red: apdu.value[0]!,
      green: apdu.value[1]!,
      blue: apdu.value[2]!,
    };
  },
  encode(v: RGBColor): APDUValue {
    for (const c of [v.red, v.green, v.blue]) {
      if (!Number.isInteger(c) || c < 0 || c > 255) {
        throw new ConversionError(
          `DPT 232.600: color components must be integer 0..255, got ${JSON.stringify(v)}`,
        );
      }
    }
    return { kind: 'bytes', value: Buffer.from([v.red, v.green, v.blue]) };
  },
};

registerDpt(codec);

// DPT 251.600 — Colour RGBW. 6 bytes:
//   [0] red   (0..255)
//   [1] green (0..255)
//   [2] blue  (0..255)
//   [3] white (0..255)
//   [4] reserved
//   [5] validity flags: bit3 red, bit2 green, bit1 blue, bit0 white

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface RGBWColor {
  red: number;
  green: number;
  blue: number;
  white: number;
  /** Channel validity bits — when omitted on encode, all four channels are flagged valid. */
  validity?: { red?: boolean; green?: boolean; blue?: boolean; white?: boolean };
}

function checkByte(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    throw new ConversionError(`DPT 251.600: ${name} must be 0..255, got ${v}`);
  }
}

const codec: DPTCodec<RGBWColor> = {
  id: '251.600',
  name: 'color_rgbw',
  decode(apdu): RGBWColor {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 6) {
      throw new ConversionError('DPT 251.600: expected 6-byte APDU');
    }
    const flags = apdu.value[5]!;
    return {
      red: apdu.value[0]!,
      green: apdu.value[1]!,
      blue: apdu.value[2]!,
      white: apdu.value[3]!,
      validity: {
        red: (flags & 0x08) !== 0,
        green: (flags & 0x04) !== 0,
        blue: (flags & 0x02) !== 0,
        white: (flags & 0x01) !== 0,
      },
    };
  },
  encode(v: RGBWColor): APDUValue {
    checkByte('red', v.red);
    checkByte('green', v.green);
    checkByte('blue', v.blue);
    checkByte('white', v.white);
    const val = v.validity;
    let flags = 0;
    if (!val || val.red !== false) flags |= 0x08;
    if (!val || val.green !== false) flags |= 0x04;
    if (!val || val.blue !== false) flags |= 0x02;
    if (!val || val.white !== false) flags |= 0x01;
    return {
      kind: 'bytes',
      value: Buffer.from([v.red, v.green, v.blue, v.white, 0x00, flags]),
    };
  },
};

registerDpt(codec);

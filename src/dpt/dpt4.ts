// DPT 4.* — Single character. 1 byte.
//   4.001 ASCII (7-bit; encode rejects characters >127)
//   4.002 ISO-8859-1 (full 8-bit)

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function makeCharCodec(id: string, name: string, encoding: 'ascii' | 'latin1'): DPTCodec<string> {
  return {
    id,
    name,
    decode(apdu): string {
      if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
        throw new ConversionError(`DPT ${id}: expected 1-byte APDU`);
      }
      return apdu.value.toString(encoding);
    },
    encode(value: string): APDUValue {
      if (typeof value !== 'string' || value.length !== 1) {
        throw new ConversionError(`DPT ${id}: value must be a single character, got "${value}"`);
      }
      const code = value.charCodeAt(0);
      const max = encoding === 'ascii' ? 127 : 255;
      // Node's Buffer.from('é','ascii') silently truncates to the low 7 bits;
      // check the original char code so out-of-range chars produce a real error.
      if (code > max) {
        throw new ConversionError(
          `DPT ${id}: character "${value}" (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is outside the ${encoding} range`,
        );
      }
      return { kind: 'bytes', value: Buffer.from([code]) };
    },
  };
}

registerDpt(makeCharCodec('4.001', 'char_ascii', 'ascii'));
registerDpt(makeCharCodec('4.002', 'char_latin1', 'latin1'));

// DPT 16.* — 14-byte string. Null-padded; trailing zero bytes are stripped on decode.
//   16.000 — ASCII (7-bit, characters >127 dropped on encode)
//   16.001 — ISO-8859-1 (Latin-1, full 8-bit)

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

const STRING_LENGTH = 14;

function makeStringCodec(id: string, name: string, encoding: 'ascii' | 'latin1'): DPTCodec<string> {
  return {
    id,
    name,
    decode(apdu): string {
      if (apdu.kind !== 'bytes' || apdu.value.length !== STRING_LENGTH) {
        throw new ConversionError(`DPT ${id}: expected ${STRING_LENGTH}-byte APDU`);
      }
      // Strip trailing zeros for the JS string view.
      let end = apdu.value.length;
      while (end > 0 && apdu.value[end - 1] === 0) end -= 1;
      return apdu.value.subarray(0, end).toString(encoding);
    },
    encode(value: string): APDUValue {
      if (typeof value !== 'string') {
        throw new ConversionError(`DPT ${id}: value must be a string, got ${typeof value}`);
      }
      const encoded = Buffer.from(value, encoding);
      if (encoded.length > STRING_LENGTH) {
        throw new ConversionError(
          `DPT ${id}: string too long (max ${STRING_LENGTH} bytes after ${encoding} encode, got ${encoded.length})`,
        );
      }
      const buf = Buffer.alloc(STRING_LENGTH); // null-padded
      encoded.copy(buf, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeStringCodec('16.000', 'string_ascii', 'ascii'));
registerDpt(makeStringCodec('16.001', 'string_latin1', 'latin1'));

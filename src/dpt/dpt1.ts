// DPT 1.* — 1-bit boolean. Encoded as a 6-bit small APDU value 0 or 1.
// All sub-types share the same codec; only the display name differs.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function makeBooleanCodec(id: string, name: string): DPTCodec<boolean> {
  return {
    id,
    name,
    decode(apdu: APDUValue): boolean {
      if (apdu.kind === 'small') return (apdu.value & 0x01) === 1;
      // 1-byte form is unusual but legal; first byte LSB carries the value.
      const first = apdu.value[0];
      if (first === undefined) {
        throw new ConversionError(`DPT ${id}: empty APDU bytes`);
      }
      return (first & 0x01) === 1;
    },
    encode(value: boolean): APDUValue {
      return { kind: 'small', value: value ? 1 : 0 };
    },
  };
}

const codecs: { id: string; name: string }[] = [
  { id: '1.001', name: 'switch' },
  { id: '1.002', name: 'bool' },
  { id: '1.003', name: 'enable' },
  { id: '1.004', name: 'ramp' },
  { id: '1.005', name: 'alarm' },
  { id: '1.006', name: 'binary_value' },
  { id: '1.007', name: 'step' },
  { id: '1.008', name: 'up_down' },
  { id: '1.009', name: 'open_close' },
  { id: '1.010', name: 'start' },
  { id: '1.011', name: 'state' },
  { id: '1.012', name: 'invert' },
  { id: '1.013', name: 'dim_send_style' },
  { id: '1.014', name: 'input_source' },
  { id: '1.015', name: 'reset' },
  { id: '1.016', name: 'ack' },
  { id: '1.017', name: 'trigger' },
  { id: '1.018', name: 'occupancy' },
  { id: '1.019', name: 'window_door' },
  { id: '1.100', name: 'heat_cool' },
];

for (const { id, name } of codecs) {
  registerDpt(makeBooleanCodec(id, name));
}

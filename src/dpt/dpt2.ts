// DPT 2.* — 2-bit control + value. Bit 1 is the control flag (whether the
// value is significant), bit 0 is the value. Carried as a small APDU.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface DPT2Value {
  control: boolean;
  value: boolean;
}

function decodeDpt2(apdu: APDUValue, id: string): DPT2Value {
  let raw: number;
  if (apdu.kind === 'small') raw = apdu.value;
  else if (apdu.kind === 'bytes' && apdu.value.length >= 1) raw = apdu.value[0]!;
  else throw new ConversionError(`DPT ${id}: invalid APDU shape`);
  return { control: (raw & 0b10) !== 0, value: (raw & 0b01) !== 0 };
}

function encodeDpt2(v: DPT2Value): APDUValue {
  const raw = (v.control ? 0b10 : 0) | (v.value ? 0b01 : 0);
  return { kind: 'small', value: raw };
}

const subTypes: { id: string; name: string }[] = [
  { id: '2.001', name: 'switch_control' },
  { id: '2.002', name: 'bool_control' },
  { id: '2.003', name: 'enable_control' },
  { id: '2.004', name: 'ramp_control' },
  { id: '2.005', name: 'alarm_control' },
  { id: '2.006', name: 'binary_control' },
  { id: '2.007', name: 'step_control' },
  { id: '2.008', name: 'updown_control' },
  { id: '2.009', name: 'openclose_control' },
  { id: '2.010', name: 'start_control' },
  { id: '2.011', name: 'state_control' },
  { id: '2.012', name: 'invert_control' },
];

for (const s of subTypes) {
  const codec: DPTCodec<DPT2Value> = {
    id: s.id,
    name: s.name,
    decode: (apdu) => decodeDpt2(apdu, s.id),
    encode: encodeDpt2,
  };
  registerDpt(codec);
}

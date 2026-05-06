// DPT 3.* — 4-bit control. Bit 3 is the control direction, bits 2..0 are the
// step code. step_code=0 means "stop"; step_code 1..7 selects 2^(step_code-1)
// equal intervals.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface DPT3Value {
  /** Direction bit. For DPT 3.007 (dimming): false=decrease, true=increase. For 3.008 (blinds): false=up, true=down. */
  control: boolean;
  /** 0 = break/stop, 1..7 = step interval. */
  stepCode: number;
}

function decodeDpt3(apdu: APDUValue, id: string): DPT3Value {
  let raw: number;
  if (apdu.kind === 'small') raw = apdu.value;
  else if (apdu.kind === 'bytes' && apdu.value.length >= 1) raw = apdu.value[0]!;
  else throw new ConversionError(`DPT ${id}: invalid APDU shape`);
  return { control: (raw & 0b1000) !== 0, stepCode: raw & 0b0111 };
}

function encodeDpt3(v: DPT3Value, id: string): APDUValue {
  if (!Number.isInteger(v.stepCode) || v.stepCode < 0 || v.stepCode > 7) {
    throw new ConversionError(`DPT ${id}: stepCode must be 0..7, got ${v.stepCode}`);
  }
  const raw = (v.control ? 0b1000 : 0) | (v.stepCode & 0b0111);
  return { kind: 'small', value: raw };
}

const subTypes: { id: string; name: string }[] = [
  { id: '3.007', name: 'control_dimming' },
  { id: '3.008', name: 'control_blinds' },
];

for (const s of subTypes) {
  const codec: DPTCodec<DPT3Value> = {
    id: s.id,
    name: s.name,
    decode: (apdu) => decodeDpt3(apdu, s.id),
    encode: (v) => encodeDpt3(v, s.id),
  };
  registerDpt(codec);
}

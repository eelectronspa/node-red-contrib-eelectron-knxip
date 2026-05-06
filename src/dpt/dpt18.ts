// DPT 18.001 — Scene control. 1 byte:
//   bit 7   control (0 = activate, 1 = learn)
//   bits 5..0  scene number 0..63

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface DPT18Value {
  /** 'activate' = recall scene; 'learn' = learn current state into scene. */
  control: 'activate' | 'learn';
  sceneNumber: number;
}

const codec: DPTCodec<DPT18Value> = {
  id: '18.001',
  name: 'scene_control',
  decode(apdu): DPT18Value {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
      throw new ConversionError('DPT 18.001: expected 1-byte APDU');
    }
    const raw = apdu.value[0]!;
    return {
      control: (raw & 0x80) !== 0 ? 'learn' : 'activate',
      sceneNumber: raw & 0x3f,
    };
  },
  encode(v: DPT18Value): APDUValue {
    if (!Number.isInteger(v.sceneNumber) || v.sceneNumber < 0 || v.sceneNumber > 63) {
      throw new ConversionError(
        `DPT 18.001: scene number must be 0..63, got ${v.sceneNumber}`,
      );
    }
    const raw = (v.control === 'learn' ? 0x80 : 0x00) | (v.sceneNumber & 0x3f);
    return { kind: 'bytes', value: Buffer.from([raw]) };
  },
};

registerDpt(codec);

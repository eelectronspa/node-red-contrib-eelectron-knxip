// DPT 26.* — 1-byte scene-info combined value.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Wire layout:
//   bit 7    reserved (0)
//   bit 6    info: 1 = active, 0 = inactive
//   bits 5..0  scene number (0..63)

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface SceneInfo {
  /** Scene index 0..63 (KNX numbers scenes from 0; ETS UIs typically display +1). */
  sceneNumber: number;
  /** True when the device reports the scene as currently active. */
  active: boolean;
}

const codec: DPTCodec<SceneInfo> = {
  id: '26.001',
  name: 'scene_info',
  decode(apdu: APDUValue): SceneInfo {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
      throw new ConversionError('DPT 26.001: expected 1-byte APDU');
    }
    const b = apdu.value[0]!;
    return {
      sceneNumber: b & 0x3f,
      active: (b & 0x40) !== 0,
    };
  },
  encode(value: SceneInfo): APDUValue {
    if (
      !value ||
      typeof value.sceneNumber !== 'number' ||
      !Number.isInteger(value.sceneNumber) ||
      value.sceneNumber < 0 ||
      value.sceneNumber > 63
    ) {
      throw new ConversionError(
        `DPT 26.001: sceneNumber must be integer 0..63, got ${value?.sceneNumber}`,
      );
    }
    const b = (value.active ? 0x40 : 0x00) | (value.sceneNumber & 0x3f);
    return { kind: 'bytes', value: Buffer.from([b]) };
  },
};

registerDpt(codec);

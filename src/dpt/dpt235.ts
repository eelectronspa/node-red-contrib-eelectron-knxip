// DPT 235.001 — Active electrical energy + tariff. 6 bytes:
//   [0..3] active energy (signed 32-bit) — Wh
//   [4]    tariff (uint8, 0..254)
//   [5]    bit1 = tariff valid, bit0 = energy valid
//
// Tariff metering devices broadcast this when reporting consumption per band.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

export interface DPT235Value {
  /** Active energy in Wh (signed 32-bit). */
  energy: number;
  /** Tariff index (0..254). */
  tariff: number;
  /** Whether the energy reading is valid. */
  energyValid?: boolean;
  /** Whether the tariff value is valid. */
  tariffValid?: boolean;
}

const codec: DPTCodec<DPT235Value> = {
  id: '235.001',
  name: 'active_energy_tariff',
  decode(apdu): DPT235Value {
    if (apdu.kind !== 'bytes' || apdu.value.length !== 6) {
      throw new ConversionError('DPT 235.001: expected 6-byte APDU');
    }
    const energy = apdu.value.readInt32BE(0);
    const tariff = apdu.value[4]!;
    const validity = apdu.value[5]!;
    return {
      energy,
      tariff,
      energyValid: (validity & 0x01) !== 0,
      tariffValid: (validity & 0x02) !== 0,
    };
  },
  encode(v: DPT235Value): APDUValue {
    if (!Number.isInteger(v.energy) || v.energy < -0x8000_0000 || v.energy > 0x7fff_ffff) {
      throw new ConversionError(`DPT 235.001: energy out of int32 range: ${v.energy}`);
    }
    if (!Number.isInteger(v.tariff) || v.tariff < 0 || v.tariff > 254) {
      throw new ConversionError(`DPT 235.001: tariff out of range (0..254): ${v.tariff}`);
    }
    let validity = 0;
    if (v.energyValid !== false) validity |= 0x01;
    if (v.tariffValid !== false) validity |= 0x02;
    const buf = Buffer.alloc(6);
    buf.writeInt32BE(v.energy, 0);
    buf[4] = v.tariff;
    buf[5] = validity;
    return { kind: 'bytes', value: buf };
  },
};

registerDpt(codec);

// DPT 13.* — signed 32-bit integer. Range -2_147_483_648..2_147_483_647.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function readInt32(apdu: APDUValue, id: string): number {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 4) {
    throw new ConversionError(`DPT ${id}: expected 4-byte APDU`);
  }
  return apdu.value.readInt32BE(0);
}

function makeInt32(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readInt32(apdu, id),
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
        throw new ConversionError(
          `DPT ${id}: value must be integer -2147483648..2147483647, got ${value}`,
        );
      }
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(value, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeInt32('13.001', 'value_4_count'));
registerDpt(makeInt32('13.002', 'flow_rate_m3h', 'm³/h'));
registerDpt(makeInt32('13.010', 'active_energy', 'Wh'));
registerDpt(makeInt32('13.011', 'apparant_energy', 'VAh'));
registerDpt(makeInt32('13.012', 'reactive_energy', 'VARh'));
registerDpt(makeInt32('13.013', 'active_energy_kwh', 'kWh'));
registerDpt(makeInt32('13.014', 'apparant_energy_kvah', 'kVAh'));
registerDpt(makeInt32('13.015', 'reactive_energy_kvarh', 'kVARh'));
registerDpt(makeInt32('13.016', 'active_energy_mwh', 'MWh'));
registerDpt(makeInt32('13.100', 'long_delta_time_sec', 's'));

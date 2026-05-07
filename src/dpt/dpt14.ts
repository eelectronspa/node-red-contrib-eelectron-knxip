// DPT 14.* — 4-byte IEEE 754 single-precision float. Trivial to encode in JS.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

interface Spec {
  id: string;
  name: string;
  unit?: string;
}

function makeCodec(spec: Spec): DPTCodec<number> {
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    decode(apdu: APDUValue): number {
      if (apdu.kind !== 'bytes' || apdu.value.length !== 4) {
        throw new ConversionError(`DPT ${spec.id}: expected 4-byte APDU`);
      }
      return apdu.value.readFloatBE(0);
    },
    encode(value: number): APDUValue {
      if (!Number.isFinite(value)) {
        throw new ConversionError(`DPT ${spec.id}: value must be finite, got ${value}`);
      }
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(value, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

// 14.* spans 80+ defined sub-types; we register the ones most likely used.
// `14.xxx` covers any unspecified sub-type as a generic float.
registerDpt(makeCodec({ id: '14.000', name: 'acceleration', unit: 'm/s²' }));
registerDpt(makeCodec({ id: '14.001', name: 'acceleration_angular', unit: 'rad/s²' }));
registerDpt(makeCodec({ id: '14.005', name: 'amplitude' }));
registerDpt(makeCodec({ id: '14.007', name: 'angle_deg', unit: '°' }));
registerDpt(makeCodec({ id: '14.008', name: 'angle_rad', unit: 'rad' }));
registerDpt(makeCodec({ id: '14.017', name: 'density', unit: 'kg/m³' }));
registerDpt(makeCodec({ id: '14.018', name: 'electric_charge', unit: 'C' }));
registerDpt(makeCodec({ id: '14.019', name: 'electric_current', unit: 'A' }));
registerDpt(makeCodec({ id: '14.020', name: 'electric_current_density', unit: 'A/m²' }));
registerDpt(makeCodec({ id: '14.027', name: 'electric_potential', unit: 'V' }));
registerDpt(makeCodec({ id: '14.031', name: 'energy_joule', unit: 'J' }));
registerDpt(makeCodec({ id: '14.032', name: 'force', unit: 'N' }));
registerDpt(makeCodec({ id: '14.033', name: 'frequency', unit: 'Hz' }));
registerDpt(makeCodec({ id: '14.039', name: 'length_m', unit: 'm' }));
registerDpt(makeCodec({ id: '14.043', name: 'luminous_intensity', unit: 'cd' }));
registerDpt(makeCodec({ id: '14.051', name: 'mass', unit: 'kg' }));
registerDpt(makeCodec({ id: '14.052', name: 'mass_flux', unit: 'kg/s' }));
registerDpt(makeCodec({ id: '14.056', name: 'power', unit: 'W' }));
registerDpt(makeCodec({ id: '14.057', name: 'power_factor' }));
registerDpt(makeCodec({ id: '14.058', name: 'pressure', unit: 'Pa' }));
registerDpt(makeCodec({ id: '14.065', name: 'speed', unit: 'm/s' }));
registerDpt(makeCodec({ id: '14.066', name: 'stress', unit: 'Pa' }));
registerDpt(makeCodec({ id: '14.068', name: 'temperature', unit: '°C' }));
registerDpt(makeCodec({ id: '14.069', name: 'temperature_K', unit: 'K' }));
registerDpt(makeCodec({ id: '14.070', name: 'temperature_difference_K', unit: 'K' }));
registerDpt(makeCodec({ id: '14.074', name: 'time_s', unit: 's' }));
registerDpt(makeCodec({ id: '14.076', name: 'volume', unit: 'm³' }));
registerDpt(makeCodec({ id: '14.077', name: 'volume_flux', unit: 'm³/s' }));
registerDpt(makeCodec({ id: '14.078', name: 'weight', unit: 'kg' }));
registerDpt(makeCodec({ id: '14.079', name: 'work', unit: 'J' }));
registerDpt(makeCodec({ id: '14.080', name: 'apparent_power', unit: 'VA' }));
registerDpt(makeCodec({ id: '14.xxx', name: 'float' }));

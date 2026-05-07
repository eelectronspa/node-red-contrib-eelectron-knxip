// DPT 9.* — KNX 2-byte float (non-IEEE).
// Layout: [S EEEE MMMMMMMMMMM]
//   bit 15:    sign
//   bits 14-11: 4-bit exponent
//   bits 10-0:  11-bit mantissa (combined with sign as a 12-bit two's complement)
//   value = (mantissa<<exponent) / 100   (signed)
//
// xknx/dpt/dpt_9.py is the canonical reference; this is a line-for-line port.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

const VALUE_MIN = -671088.64;
const VALUE_MAX = 670760.96;

interface Spec {
  id: string;
  name: string;
  unit?: string;
  min?: number;
  max?: number;
}

function readPair(apdu: APDUValue, id: string): [number, number] {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 2) {
    throw new ConversionError(`DPT ${id}: expected 2-byte APDU`);
  }
  return [apdu.value[0]!, apdu.value[1]!];
}

function decode2ByteFloat(apdu: APDUValue, id: string, min: number, max: number): number {
  const [hi, lo] = readPair(apdu, id);
  const data = (hi << 8) | lo;
  const exponent = (data >> 11) & 0x0f;
  let significand = data & 0x07ff;
  const sign = data >> 15;
  if (sign === 1) significand -= 2048;
  const value = (significand << exponent) / 100;
  if (value < min || value > max) {
    throw new ConversionError(
      `DPT ${id}: decoded value ${value} out of range (${min}..${max})`,
    );
  }
  return value;
}

function encode2ByteFloat(value: number, id: string, min: number, max: number): APDUValue {
  if (!Number.isFinite(value)) {
    throw new ConversionError(`DPT ${id}: value must be finite, got ${value}`);
  }
  if (value < min || value > max) {
    throw new ConversionError(`DPT ${id}: value ${value} out of range (${min}..${max})`);
  }
  let knx = value * 100;
  if (Math.round(knx) === 0) {
    return { kind: 'bytes', value: Buffer.from([0x00, 0x00]) };
  }
  let exponent = 0;
  while (knx < -2048 || knx > 2047) {
    exponent += 1;
    knx /= 2;
  }
  const mantissa = Math.round(knx) & 0x7ff;
  let msb = (exponent << 3) | (mantissa >> 8);
  if (knx < 0) msb |= 0x80;
  return { kind: 'bytes', value: Buffer.from([msb & 0xff, mantissa & 0xff]) };
}

function makeCodec(spec: Spec): DPTCodec<number> {
  const min = spec.min ?? VALUE_MIN;
  const max = spec.max ?? VALUE_MAX;
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    decode: (apdu) => decode2ByteFloat(apdu, spec.id, min, max),
    encode: (value) => encode2ByteFloat(value, spec.id, min, max),
  };
}

// Common 9.* sub-types — names follow xknx, units per KNX spec.
// Bounds are not enforced per sub-type because the on-wire encoding's natural
// precision exceeds advisory maxima at large magnitudes (encoding 670760 may
// decode back as 670760.96 — both legal). Use the global VALUE_MIN..VALUE_MAX
// for safety only; advisory mins (e.g. ≥0 for humidity) are user-visible
// documentation, not runtime enforcement.
registerDpt(makeCodec({ id: '9.001', name: 'temperature', unit: '°C' }));
registerDpt(makeCodec({ id: '9.002', name: 'temperature_difference', unit: 'K' }));
registerDpt(makeCodec({ id: '9.003', name: 'temperature_a', unit: 'K/h' }));
registerDpt(makeCodec({ id: '9.004', name: 'lux', unit: 'lx' }));
registerDpt(makeCodec({ id: '9.005', name: 'wind_speed_ms', unit: 'm/s' }));
registerDpt(makeCodec({ id: '9.006', name: 'pressure', unit: 'Pa' }));
registerDpt(makeCodec({ id: '9.007', name: 'humidity', unit: '%' }));
registerDpt(makeCodec({ id: '9.008', name: 'ppm', unit: 'ppm' }));
registerDpt(makeCodec({ id: '9.010', name: 'time_s', unit: 's' }));
registerDpt(makeCodec({ id: '9.011', name: 'time_ms', unit: 'ms' }));
registerDpt(makeCodec({ id: '9.020', name: 'voltage', unit: 'mV' }));
registerDpt(makeCodec({ id: '9.021', name: 'current', unit: 'mA' }));
registerDpt(makeCodec({ id: '9.022', name: 'power_density', unit: 'W/m²' }));
registerDpt(makeCodec({ id: '9.023', name: 'kelvin_per_percent', unit: 'K/%' }));
registerDpt(makeCodec({ id: '9.024', name: 'power', unit: 'kW' }));
registerDpt(makeCodec({ id: '9.025', name: 'volume_flow', unit: 'l/h' }));
registerDpt(makeCodec({ id: '9.026', name: 'rain_amount', unit: 'l/m²' }));
registerDpt(makeCodec({ id: '9.027', name: 'temperature_F', unit: '°F' }));
registerDpt(makeCodec({ id: '9.028', name: 'wind_speed_kmh', unit: 'km/h' }));
registerDpt(makeCodec({ id: '9.029', name: 'absolute_humidity', unit: 'g/m³' }));
registerDpt(makeCodec({ id: '9.030', name: 'air_quality', unit: 'µg/m³' }));

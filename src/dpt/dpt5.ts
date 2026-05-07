// DPT 5.* — 8-bit unsigned integer. Some sub-types apply a linear scaling.
// All values cross the wire as a 1-byte APDU (`kind: 'bytes'` length 1) — note
// this is different from DPT1 which uses the small-payload encoding.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

interface ScaledSpec {
  id: string;
  name: string;
  unit?: string;
  /** Logical max (raw 0..255 maps linearly to 0..max). */
  max: number;
  /** Optional override of the human-side rounding. Default: `Math.round`. */
  round?: (value: number) => number;
}

function readByte(apdu: APDUValue, dptId: string): number {
  if (apdu.kind !== 'bytes') {
    throw new ConversionError(`DPT ${dptId}: expected 1-byte APDU, got small payload`);
  }
  if (apdu.value.length !== 1) {
    throw new ConversionError(
      `DPT ${dptId}: expected 1-byte APDU, got ${apdu.value.length} bytes`,
    );
  }
  return apdu.value[0]!;
}

function makeScaledCodec(spec: ScaledSpec): DPTCodec<number> {
  const round = spec.round ?? Math.round;
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    decode(apdu: APDUValue): number {
      const raw = readByte(apdu, spec.id);
      return (raw / 255) * spec.max;
    },
    encode(value: number): APDUValue {
      if (!Number.isFinite(value)) {
        throw new ConversionError(`DPT ${spec.id}: value must be finite, got ${value}`);
      }
      const raw = round((value / spec.max) * 255);
      if (raw < 0 || raw > 255) {
        throw new ConversionError(
          `DPT ${spec.id}: value ${value} out of range (0..${spec.max})`,
        );
      }
      return { kind: 'bytes', value: Buffer.from([raw]) };
    },
  };
}

function makeRawCodec(id: string, name: string, unit?: string): DPTCodec<number> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode(apdu: APDUValue): number {
      return readByte(apdu, id);
    },
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new ConversionError(`DPT ${id}: value must be integer 0..255, got ${value}`);
      }
      return { kind: 'bytes', value: Buffer.from([value]) };
    },
  };
}

registerDpt(makeScaledCodec({ id: '5.001', name: 'percent', unit: '%', max: 100 }));
registerDpt(makeScaledCodec({ id: '5.003', name: 'angle', unit: '°', max: 360 }));
registerDpt(makeRawCodec('5.004', 'percent_u8', '%'));
registerDpt(makeRawCodec('5.005', 'decimal_factor'));
registerDpt(makeRawCodec('5.006', 'tariff'));
registerDpt(makeRawCodec('5.010', 'counter_pulses'));

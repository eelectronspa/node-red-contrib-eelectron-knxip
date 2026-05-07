// DPT 29.* — 8-byte signed integer (-2^63..2^63-1).
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Used for high-precision energy measurements (active / apparent / reactive
// energy in Wh) on heavy-traffic meters where the 32-bit DPT 13 family
// would overflow.
//
// Codec accepts and returns `bigint` because energy totals routinely exceed
// `Number.MAX_SAFE_INTEGER` (2^53−1 = ~9 PWh — small fault-tolerant for
// general industrial use, but easy to exceed at high-resolution accumulation).

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

const MIN = -(2n ** 63n);
const MAX = 2n ** 63n - 1n;

function readInt64(apdu: APDUValue, id: string): bigint {
  if (apdu.kind !== 'bytes' || apdu.value.length !== 8) {
    throw new ConversionError(`DPT ${id}: expected 8-byte APDU`);
  }
  return apdu.value.readBigInt64BE(0);
}

function makeInt64(id: string, name: string, unit?: string): DPTCodec<bigint> {
  return {
    id,
    name,
    ...(unit !== undefined ? { unit } : {}),
    decode: (apdu) => readInt64(apdu, id),
    encode(value: bigint): APDUValue {
      // Be tolerant of plain numbers — most callers will pass `123` rather
      // than `123n`. Coerce when safe (fits as a JS integer); reject floats.
      let bi: bigint;
      if (typeof value === 'bigint') {
        bi = value;
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
          throw new ConversionError(`DPT ${id}: value must be an integer, got ${value}`);
        }
        bi = BigInt(value);
      } else {
        throw new ConversionError(`DPT ${id}: value must be bigint | integer number, got ${typeof value}`);
      }
      if (bi < MIN || bi > MAX) {
        throw new ConversionError(`DPT ${id}: value ${bi} out of int64 range`);
      }
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(bi, 0);
      return { kind: 'bytes', value: buf };
    },
  };
}

registerDpt(makeInt64('29.010', 'active_energy_v64', 'Wh'));
registerDpt(makeInt64('29.011', 'apparent_energy_v64', 'VAh'));
registerDpt(makeInt64('29.012', 'reactive_energy_v64', 'VARh'));

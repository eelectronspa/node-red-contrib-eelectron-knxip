// DPT (Datapoint Type) registry. A DPT codec encodes a high-level JS value
// (boolean, number, string, ...) to a KNX APDU value and back. The registry is
// keyed by DPT id (e.g. '1.001', '5.001', '9.001').
//
// Registry is process-global — codecs are stateless lookups, so sharing across
// multiple TunnelClient instances is safe.

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';

export interface DPTCodec<TValue = unknown> {
  /** DPT id, e.g. '1.001'. */
  readonly id: string;
  /** Human-readable name, e.g. 'switch', 'percent'. */
  readonly name: string;
  /** Optional unit suffix (e.g. '°C', '%'). */
  readonly unit?: string;
  /** Decode a received APDU value into the high-level JS value. */
  decode(apdu: APDUValue): TValue;
  /** Encode the JS value into an APDU value ready for `groupValueWrite`. */
  encode(value: TValue): APDUValue;
}

const registry = new Map<string, DPTCodec<unknown>>();

export function registerDpt(codec: DPTCodec<unknown>): void {
  registry.set(codec.id, codec);
}

export function getDpt(id: string): DPTCodec<unknown> {
  const codec = registry.get(id);
  if (!codec) {
    throw new ConversionError(`Unknown DPT id "${id}"`);
  }
  return codec;
}

export function hasDpt(id: string): boolean {
  return registry.has(id);
}

/** All registered DPT ids (alphabetical). Mostly for diagnostics/UIs. */
export function listDpts(): string[] {
  return [...registry.keys()].sort();
}

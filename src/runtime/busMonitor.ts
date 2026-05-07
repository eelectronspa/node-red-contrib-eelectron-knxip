// In-memory ring buffer + emitter for KNX/IP bus telegrams.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// One singleton per Node-RED process. Tunnel-config nodes push records as
// telegrams arrive; the editor's bus-monitor sidebar subscribes via SSE.
//
// Buffer is bounded so a quiet operator doesn't bloat memory across uptime;
// the cap is per-process, not per-tunnel.

import { EventEmitter } from 'node:events';

export interface TelegramDecoded {
  /** Decoded JS value (bool, number, string, structured object — DPT-dependent). */
  value: unknown;
  /** Normalised DPT id (`"M.s"`). */
  dpt: string;
  /** Group-address display name from the ETS project, when known. */
  gaName?: string;
  /** Engineering unit (`"%"`, `"°C"`, …) when the codec exposes one. */
  unit?: string;
}

export interface TelegramRecord {
  /** Wall-clock time (ms since epoch). */
  ts: number;
  /** Tunnel-config node id this telegram came from. */
  tunnelId: string;
  /** Tunnel-config display label (its `name` or `gatewayIp:port`). */
  tunnelLabel: string;
  /** 'in' = received from the bus; 'out' = sent by us. (Only 'in' for now.) */
  direction: 'in' | 'out';
  /** Source individual address ("1.1.42") or `null` if unparseable. */
  source: string | null;
  /** Destination group address ("1/2/3") or `null` if not a group telegram. */
  destination: string | null;
  /** APCI kind: `'GroupValueRead'` / `'GroupValueWrite'` / `'GroupValueResponse'` / `'other'`. */
  apci: string;
  /** Raw APDU bytes as lowercase hex. */
  raw: string;
  /** Decoded value when an ETS config covers this GA. */
  decoded?: TelegramDecoded;
}

export const DEFAULT_BUFFER_SIZE = 500;

/**
 * Bounded in-memory ring buffer with an event emitter for live subscribers.
 * Designed to be cheap: push is O(1) amortised (one shift when full), and
 * `recent()` returns a sliced copy so callers can't mutate the live buffer.
 */
export class BusMonitor extends EventEmitter {
  private _buffer: TelegramRecord[] = [];
  private readonly _max: number;

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE) {
    super();
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(`BusMonitor maxSize must be a positive integer (got ${maxSize})`);
    }
    this._max = maxSize;
    // Sidebars + child nodes can each register listeners; raise the cap so
    // Node doesn't print MaxListenersExceededWarning in busy projects.
    this.setMaxListeners(0);
  }

  push(record: TelegramRecord): void {
    this._buffer.push(record);
    if (this._buffer.length > this._max) {
      // Overflow: drop oldest. (`shift` is O(n); for a 500-element buffer
      // that's still nanoseconds — not worth a circular-array optimisation
      // until we measure a real cost.)
      this._buffer.shift();
    }
    this.emit('telegram', record);
  }

  recent(limit: number = this._max): TelegramRecord[] {
    if (limit <= 0) return [];
    return this._buffer.slice(-Math.min(limit, this._buffer.length));
  }

  clear(): void {
    this._buffer = [];
    this.emit('cleared');
  }

  get size(): number {
    return this._buffer.length;
  }

  get capacity(): number {
    return this._max;
  }
}

/** Process-wide singleton. */
export const busMonitor = new BusMonitor();

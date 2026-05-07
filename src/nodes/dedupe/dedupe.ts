// eelectron-knxip-dedupe — drops repeated (topic, payload) pairs that arrive
// within the configured time window.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Useful for cleaning a noisy listener stream (some KNX devices re-send the
// same value every few seconds even when nothing has changed) and for
// breaking write→listener feedback loops where a writer's own write is
// echoed back by the gateway and would otherwise drive the next write.
//
// Generalised version of the dedupe option already built into the writer
// node — works on any topic + payload combination, not just outbound writes.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';

interface DedupeProps {
  /** Drop repeats arriving within this many ms. Default 1000 ms. */
  windowMs?: string | number;
  /** Track per-topic (default true) or use a single global bucket. */
  perTopic?: boolean;
}

type Def = NodeDef & DedupeProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Stable, reasonably fast comparison for KNX payloads. Primitives compare by
 * value; objects (e.g. DPT 10 time, DPT 11 date, DPT 232 RGB) compare by
 * canonicalised JSON. Buffers compare byte-for-byte — guard against the
 * `bytes` APDU shape having different Buffer instances backing identical
 * data.
 */
function payloadsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (typeof a !== 'object') return false;
  // Stringify with a stable key order so {x:1,y:2} === {y:2,x:1}.
  return canon(a) === canon(b);
}

function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return `B:${(value as Buffer).toString('hex')}`;
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export = function (RED: NodeAPI) {
  function DedupeCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const windowMs = toNumber(def.windowMs, 1000);
    const perTopic = def.perTopic !== false; // default true

    type Slot = { ts: number; payload: unknown };
    const last = new Map<string, Slot>();
    let suppressed = 0;
    let passed = 0;

    function key(msg: NodeMessage): string {
      if (!perTopic) return '__global__';
      return typeof msg.topic === 'string' ? msg.topic : '';
    }

    function refreshStatus(): void {
      self.status({
        fill: 'green',
        shape: 'dot',
        text: `pass ${passed} · drop ${suppressed}`,
      });
    }
    refreshStatus();

    self.on('input', (msg: NodeMessage, send, done) => {
      const k = key(msg);
      const slot = last.get(k);
      const now = Date.now();
      if (slot && now - slot.ts < windowMs && payloadsEqual(slot.payload, msg.payload)) {
        // Update only the timestamp so a slow trickle of identical messages
        // keeps the window rolling — first non-equal message will pass even
        // if it arrives N×windowMs later.
        slot.ts = now;
        suppressed += 1;
        refreshStatus();
        if (done) done();
        return;
      }
      last.set(k, { ts: now, payload: msg.payload });
      passed += 1;
      refreshStatus();
      send(msg);
      if (done) done();
    });

    self.on('close', () => {
      last.clear();
    });
  }

  RED.nodes.registerType('eelectron-knxip-dedupe', DedupeCtor as unknown as () => void);
};

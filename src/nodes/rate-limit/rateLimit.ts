// eelectron-knxip-rate-limit — caps msgs/window per topic so a runaway flow
// can't storm the bus.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Strategy is plain "drop excess" — the simplest behaviour that fixes the
// failure mode this node exists for. A buffer-and-emit-at-rate variant could
// be added later for use cases where every message must eventually go out.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';

interface RateLimitProps {
  /** Max messages allowed per window. Default 5. */
  maxPerWindow?: string | number;
  /** Window length in ms. Default 1000 ms. */
  windowMs?: string | number;
  /** Track per-topic (default true) or use a single global bucket. */
  perTopic?: boolean;
  /** When true, dropped messages go out on a 2nd output instead of being silently discarded. */
  exposeDropped?: boolean;
}

type Def = NodeDef & RateLimitProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export = function (RED: NodeAPI) {
  function RateLimitCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const maxPerWindow = Math.max(1, Math.floor(toNumber(def.maxPerWindow, 5)));
    const windowMs = Math.max(1, toNumber(def.windowMs, 1000));
    const perTopic = def.perTopic !== false; // default true
    const exposeDropped = def.exposeDropped === true;

    // Sliding-window counter: store recent timestamps per key, evict old ones
    // on each message. Bounded by maxPerWindow per key, so memory is small
    // even with thousands of distinct topics.
    type Bucket = number[];
    const buckets = new Map<string, Bucket>();
    let passed = 0;
    let dropped = 0;

    function refreshStatus(): void {
      self.status({
        fill: 'green',
        shape: 'dot',
        text: `pass ${passed} · drop ${dropped}`,
      });
    }
    refreshStatus();

    function key(msg: NodeMessage): string {
      if (!perTopic) return '__global__';
      return typeof msg.topic === 'string' ? msg.topic : '';
    }

    self.on('input', (msg: NodeMessage, send, done) => {
      const k = key(msg);
      const now = Date.now();
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = [];
        buckets.set(k, bucket);
      }
      // Evict timestamps older than the window.
      const cutoff = now - windowMs;
      while (bucket.length > 0 && bucket[0]! < cutoff) {
        bucket.shift();
      }
      // node-red typings disagree on whether `[null, msg]` arrays are
      // assignable to the send-signature's positional array — both forms are
      // accepted at runtime. The local cast scopes the unsafe assertion to
      // exactly the two-output dispatch.
      const sendDual = self.send as unknown as (m: Array<NodeMessage | null>) => void;
      if (bucket.length >= maxPerWindow) {
        dropped += 1;
        refreshStatus();
        if (exposeDropped) {
          sendDual([null, msg]);
        }
        if (done) done();
        return;
      }
      bucket.push(now);
      passed += 1;
      refreshStatus();
      if (exposeDropped) {
        sendDual([msg, null]);
      } else {
        send(msg);
      }
      if (done) done();
    });

    self.on('close', () => {
      buckets.clear();
    });
  }

  RED.nodes.registerType('eelectron-knxip-rate-limit', RateLimitCtor as unknown as () => void);
};

// eelectron-knxip-ets-inject — KNX-aware inject node.
//
// Like the standard `inject`, but the topic/payload are driven by a GA picked
// from a bound ETS project. The runtime emits:
//   {
//     payload:  user-typed value (raw — boolean, number, string, etc.)
//     topic:    GA in long form (e.g. "1/2/3")
//     dpt:      DPT id from the ETS map (e.g. "1.001")
//     gaName:   friendly name from the ETS map
//   }
//
// Pipe into a `knxip writer` (with the same ETS config bound) and the writer
// will auto-encode using the per-GA DPT — no encoder node needed in between.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import type { KnxEtsConfigNode } from '../shared/configNode';

interface ETSInjectProps {
  etsConfig: string;
  /** Group address selected from the ETS project. */
  ga?: string;
  /** Payload as a JSON-encoded literal (so e.g. `true`, `42`, `"hello"`, `{r,g,b}` all work). */
  payloadJson?: string;
  /** When set to a positive integer, the node fires repeatedly every N ms. */
  repeatMs?: string | number;
  /** Fire once shortly after deploy. */
  once?: boolean;
  /** Delay (ms) before the on-deploy fire when `once` is true. */
  onceDelayMs?: string | number;
}

type Def = NodeDef & ETSInjectProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function safeParseJson(text: string | undefined): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // If it isn't valid JSON, hand it back as a literal string. This is
    // friendly for users who type "hello" without quotes or `42` etc.
    return text;
  }
}

export = function (RED: NodeAPI) {
  function EtsInjectCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.etsConfig) as unknown as
      | (Node & KnxEtsConfigNode)
      | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no ETS config' });
      return;
    }

    const ga = (def.ga ?? '').trim();
    const payload = safeParseJson(def.payloadJson);
    const entry = ga ? cfg.map.get(ga) : null;

    if (!ga) {
      self.status({ fill: 'yellow', shape: 'ring', text: 'pick a GA' });
    } else if (!entry) {
      self.status({ fill: 'yellow', shape: 'ring', text: `${ga} not in ETS` });
    } else {
      self.status({ fill: 'grey', shape: 'dot', text: `${ga} · ${entry.dpt ?? '?'}` });
    }

    const fire = () => {
      if (!ga || !entry) return;
      self.send({
        payload,
        topic: ga,
        ...(entry.dpt ? { dpt: entry.dpt } : {}),
        ...(entry.name ? { gaName: entry.name } : {}),
      } as NodeMessage);
      self.status({
        fill: 'green',
        shape: 'dot',
        text: `${ga} · sent ${new Date().toISOString().slice(11, 19)}`,
      });
    };

    // Manual trigger via the inject button (Node-RED sends an 'input' msg).
    const onInput = () => fire();
    (self.on as unknown as (event: 'input', cb: typeof onInput) => void)('input', onInput);

    // Fire-on-deploy and repeat interval.
    let repeatTimer: NodeJS.Timeout | null = null;
    let onceTimer: NodeJS.Timeout | null = null;

    const repeatMs = toNumber(def.repeatMs, 0);
    if (repeatMs > 0) {
      repeatTimer = setInterval(() => fire(), repeatMs);
      repeatTimer.unref?.();
    }

    if (def.once) {
      const delay = toNumber(def.onceDelayMs, 100);
      onceTimer = setTimeout(() => fire(), delay);
      onceTimer.unref?.();
    }

    self.on('close', (_removed: boolean, done: () => void) => {
      if (repeatTimer) clearInterval(repeatTimer);
      if (onceTimer) clearTimeout(onceTimer);
      done();
    });
  }

  RED.nodes.registerType(
    'eelectron-knxip-ets-inject',
    EtsInjectCtor as unknown as () => void,
  );
};

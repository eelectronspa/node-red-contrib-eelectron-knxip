// eelectron-knxip-state-store — caches per-GA last-known values, queryable
// via input messages.
//
// Default action ("set"): index `msg.payload` by `msg.topic` (the GA), passing
// the message through unchanged so it can fan out to other consumers.
//
// Query actions (selected via `msg.action`):
//   - 'get'    msg.topic = GA → emit stored value as msg.payload (or null if missing)
//   - 'list'   → emit a snapshot array of { ga, payload, dpt, gaName, source, at }
//   - 'clear'  → clear all entries; with msg.topic, clear only that GA
//
// State is in-memory and per-node — multiple state-store nodes don't share.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import { GroupAddress } from '../../core/address';

interface StateStoreProps {
  config?: string;
  /** Optional cap on entries to keep memory bounded for very large projects. */
  maxEntries?: string | number;
}

type Def = NodeDef & StateStoreProps;

interface KnxMessage extends NodeMessage {
  action?: 'set' | 'get' | 'list' | 'clear';
  topic?: string;
  payload?: unknown;
  dpt?: string;
  gaName?: string;
  knx?: { source?: string; [k: string]: unknown };
}

interface StoredEntry {
  ga: string;
  payload: unknown;
  dpt?: string;
  gaName?: string;
  source?: string;
  at: string;
}

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export = function (RED: NodeAPI) {
  function StateStoreCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;

    const maxEntries = Math.max(0, toNumber(def.maxEntries, 0));
    const store = new Map<number, StoredEntry>();

    const refreshStatus = () => {
      self.status({ fill: 'grey', shape: 'dot', text: `${store.size} entries` });
    };
    refreshStatus();

    const onInput = (
      msg: KnxMessage,
      send: ((m: NodeMessage | NodeMessage[] | null) => void) | undefined,
      done: ((err?: Error) => void) | undefined,
    ) => {
      const finish = (err?: Error) => {
        if (done) done(err);
        else if (err) self.error(err.message, msg as NodeMessage);
      };
      const emit = (out: NodeMessage | null) => {
        if (send) send(out);
        else if (out) self.send(out);
      };

      const action = msg.action ?? 'set';

      try {
        if (action === 'list') {
          const snapshot: StoredEntry[] = [...store.values()];
          emit({
            payload: snapshot,
            topic: 'state-list',
          } as unknown as NodeMessage);
          finish();
          return;
        }

        if (action === 'clear') {
          if (msg.topic) {
            try {
              const raw = new GroupAddress(msg.topic).raw;
              store.delete(raw);
            } catch {
              /* ignore — invalid GA on clear is a no-op */
            }
          } else {
            store.clear();
          }
          refreshStatus();
          finish();
          return;
        }

        // 'get' and 'set' both need a topic
        if (!msg.topic) {
          finish(new Error('msg.topic (group address) is required'));
          return;
        }
        const raw = new GroupAddress(msg.topic).raw;

        if (action === 'get') {
          const entry = store.get(raw);
          emit({
            ...msg,
            payload: entry?.payload ?? null,
            knx: {
              ...(msg.knx ?? {}),
              found: !!entry,
              ...(entry ? { storedAt: entry.at, dpt: entry.dpt, gaName: entry.gaName } : {}),
            },
          } as unknown as NodeMessage);
          finish();
          return;
        }

        // 'set' (default) — record then pass through
        if (maxEntries > 0 && !store.has(raw) && store.size >= maxEntries) {
          // Drop the oldest entry to keep size bounded.
          const oldestKey = store.keys().next().value;
          if (oldestKey !== undefined) store.delete(oldestKey);
        }
        const entry: StoredEntry = {
          ga: msg.topic,
          payload: msg.payload,
          ...(typeof msg.dpt === 'string' ? { dpt: msg.dpt } : {}),
          ...(typeof msg.gaName === 'string' ? { gaName: msg.gaName } : {}),
          ...(typeof msg.knx?.source === 'string' ? { source: msg.knx.source } : {}),
          at: new Date().toISOString(),
        };
        store.set(raw, entry);
        refreshStatus();
        emit(msg as NodeMessage);
        finish();
      } catch (err) {
        finish(err as Error);
      }
    };

    (self.on as unknown as (event: 'input', cb: typeof onInput) => void)('input', onInput);

    self.on('close', (_removed: boolean, done: () => void) => {
      store.clear();
      done();
    });
  }

  RED.nodes.registerType(
    'eelectron-knxip-state-store',
    StateStoreCtor as unknown as () => void,
  );
};

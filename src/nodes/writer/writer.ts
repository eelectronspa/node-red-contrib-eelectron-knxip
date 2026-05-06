// eelectron-knxip-writer — single node for both GroupValueWrite and
// GroupValueRead. Read mode is selected when `msg.read === true` or the
// payload is undefined.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import { GroupAddress } from '../../core/address';
import { type APDUValue, smallValue } from '../../core/apci';
import { getDpt, hasDpt } from '../../dpt';
import type { KnxConfigNode, KnxEtsConfigNode } from '../shared/configNode';

interface WriterProps {
  config: string;
  /** Optional ETS config; when bound, DPT lookups fall through the project map for the target GA. */
  etsConfig?: string;
  groupAddress?: string;
  dpt?: string;
  /**
   * Optional anti-loop guard. When set to a positive integer, the writer
   * suppresses any GroupValueWrite that targets the same GA with the same
   * APDU value as the last one within this many milliseconds. 0/empty disables
   * the guard. Useful for breaking accidental feedback loops between Node-RED
   * and external systems (e.g. Home Assistant + a third-party bridge).
   */
  dedupeWindowMs?: string | number;
}

type Def = NodeDef & WriterProps;

interface KnxMessage extends NodeMessage {
  topic?: string;
  payload?: unknown;
  read?: boolean;
  dpt?: string;
}

function isApduValue(payload: unknown): payload is APDUValue {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'kind' in payload &&
    ((payload as APDUValue).kind === 'small' || (payload as APDUValue).kind === 'bytes')
  );
}

function apduEquals(a: APDUValue, b: APDUValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'small' && b.kind === 'small') return a.value === b.value;
  if (a.kind === 'bytes' && b.kind === 'bytes') return a.value.equals(b.value);
  return false;
}

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function coerceApdu(payload: unknown): APDUValue {
  if (isApduValue(payload)) return payload;
  if (Buffer.isBuffer(payload)) return { kind: 'bytes', value: payload };
  if (typeof payload === 'boolean') return smallValue(payload ? 1 : 0);
  if (typeof payload === 'number' && Number.isInteger(payload) && payload >= 0 && payload <= 0x3f) {
    return smallValue(payload);
  }
  throw new Error(
    `Cannot coerce payload to APDU value without a DPT: ${typeof payload}`,
  );
}

export = function (RED: NodeAPI) {
  function WriterCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.config) as unknown as (Node & KnxConfigNode) | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }
    const ets = def.etsConfig
      ? (RED.nodes.getNode(def.etsConfig) as unknown as (Node & KnxEtsConfigNode) | null)
      : null;

    cfg.attach(self.id);

    const dedupeWindowMs = toNumber(def.dedupeWindowMs, 0);
    const lastWrites = new Map<number, { apdu: APDUValue; ts: number }>();
    let suppressedCount = 0;

    const onInput = async (
      msg: KnxMessage,
      _send: (m: NodeMessage | NodeMessage[]) => void,
      done: (err?: Error) => void,
    ) => {
      try {
        const gaText = msg.topic ?? def.groupAddress;
        if (!gaText) throw new Error('No group address (set msg.topic or configure one)');
        const dst = new GroupAddress(gaText, cfg.groupAddressStyle);

        const isRead = msg.read === true || msg.payload === undefined;
        if (isRead) {
          await cfg.client.groupValueRead(dst);
          done();
          return;
        }

        // If an upstream node (e.g. the ETS translator) already produced an
        // APDU value, pass it through unchanged — encoding it again with a DPT
        // codec would mangle it ("value must be finite, got [object Object]").
        let apdu: APDUValue;
        if (isApduValue(msg.payload)) {
          apdu = msg.payload;
        } else {
          // DPT resolution order: msg.dpt → node default → ETS map → coerce.
          let dptId: string | undefined = msg.dpt ?? def.dpt;
          if (!dptId && ets) {
            const entry = ets.map.get(dst);
            if (entry?.dpt) dptId = entry.dpt;
          }
          if (dptId) {
            if (!hasDpt(dptId)) throw new Error(`Unknown DPT "${dptId}"`);
            apdu = getDpt(dptId).encode(msg.payload as never);
          } else {
            apdu = coerceApdu(msg.payload);
          }
        }

        // Anti-loop guard: drop identical writes to the same GA within the
        // configured window. Always passes when window is 0 (disabled).
        if (dedupeWindowMs > 0) {
          const last = lastWrites.get(dst.raw);
          const now = Date.now();
          if (last && now - last.ts < dedupeWindowMs && apduEquals(last.apdu, apdu)) {
            suppressedCount += 1;
            self.status({
              fill: 'yellow',
              shape: 'ring',
              text: `suppressed ${suppressedCount} dup`,
            });
            self.debug(
              `Suppressed duplicate write to ${dst.toString()} within ${dedupeWindowMs}ms`,
            );
            done();
            return;
          }
          lastWrites.set(dst.raw, { apdu, ts: now });
        }

        await cfg.client.groupValueWrite(dst, apdu);
        done();
      } catch (err) {
        done(err as Error);
      }
    };

    // node-red's TS types narrow `.on()` heavily — cast through unknown for the input listener
    (self.on as unknown as (event: 'input', cb: typeof onInput) => void)('input', onInput);

    self.on('close', (_removed: boolean, done: () => void) => {
      cfg.detach(self.id);
      done();
    });
  }

  RED.nodes.registerType('eelectron-knxip-writer', WriterCtor as unknown as () => void);
};

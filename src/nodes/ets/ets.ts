// eelectron-knxip-ets — ETS-aware translator node.
//
// Sits in the wire between (listener → here → downstream) for decoding, or
// (inject → here → writer) for encoding. Looks up `msg.topic` (group address)
// in the ETS config's project map, finds its DPT, and applies the right codec.
//
// Two outputs:
//   1 → translated message (decoded value or encoded APDU value)
//   2 → raw passthrough for messages we couldn't translate (unknown GA,
//       unknown DPT, decode/encode error). The original msg.payload is preserved
//       so the user can plug a function node into output 2 for custom handling.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import { GroupAddress } from '../../core/address';
import type { APDUValue } from '../../core/apci';
import { getDpt, hasDpt } from '../../dpt';
import type { ETSEntry } from '../../ets/projectMap';
import type { KnxEtsConfigNode } from '../shared/configNode';

interface ETSProps {
  config: string;
  mode?: 'auto' | 'decode' | 'encode';
}

type Def = NodeDef & ETSProps;

interface KnxMessage extends NodeMessage {
  topic?: string;
  payload?: unknown;
  dpt?: string;
  gaName?: string | undefined;
  etsReason?: string | undefined;
}

function isApduValue(payload: unknown): payload is APDUValue {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    ((payload as APDUValue).kind === 'small' || (payload as APDUValue).kind === 'bytes')
  );
}

export = function (RED: NodeAPI) {
  function EtsCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.config) as unknown as
      | (Node & KnxEtsConfigNode)
      | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }

    const mode = def.mode ?? 'auto';

    self.status({
      fill: 'green',
      shape: 'dot',
      text: `${cfg.entryCount} GAs · ${mode}`,
    });

    const onInput = (
      msg: KnxMessage,
      send: ((m: (NodeMessage | null)[]) => void) | undefined,
      done: ((err?: Error) => void) | undefined,
    ) => {
      const finish = (err?: Error) => {
        if (done) done(err);
        else if (err) self.error(err.message, msg as NodeMessage);
      };
      const emit = (out1: NodeMessage | null, out2: NodeMessage | null) => {
        if (send) send([out1, out2]);
        else self.send([out1, out2] as NodeMessage[]);
      };

      const passThrough = (reason: string) => {
        const raw: KnxMessage = { ...msg, etsReason: reason };
        emit(null, raw);
      };

      const ga = (msg.topic ?? '').trim();
      if (!ga) {
        passThrough('no msg.topic');
        finish();
        return;
      }

      let entry: ETSEntry | null;
      try {
        entry = cfg.map.get(new GroupAddress(ga));
      } catch (err) {
        passThrough(`invalid group address: ${(err as Error).message}`);
        finish();
        return;
      }

      if (!entry) {
        passThrough('group address not in ETS project');
        finish();
        return;
      }
      if (!entry.dpt || !hasDpt(entry.dpt)) {
        passThrough(
          entry.dptRaw
            ? `DPT ${entry.dptRaw} not registered`
            : 'no DPT in ETS for this group address',
        );
        finish();
        return;
      }

      const codec = getDpt(entry.dpt);
      const direction =
        mode === 'auto' ? (isApduValue(msg.payload) ? 'decode' : 'encode') : mode;

      try {
        if (direction === 'decode') {
          if (!isApduValue(msg.payload)) {
            passThrough('decode: payload is not an APDU value');
            finish();
            return;
          }
          const value = codec.decode(msg.payload);
          const out: KnxMessage = {
            ...msg,
            payload: value,
            dpt: entry.dpt,
            gaName: entry.name || undefined,
          };
          emit(out, null);
        } else {
          // encode
          const apdu = codec.encode(msg.payload as never);
          const out: KnxMessage = {
            ...msg,
            payload: apdu,
            dpt: entry.dpt,
            gaName: entry.name || undefined,
          };
          emit(out, null);
        }
        finish();
      } catch (err) {
        passThrough(`${direction} error: ${(err as Error).message}`);
        finish();
      }
    };

    (self.on as unknown as (event: 'input', cb: typeof onInput) => void)('input', onInput);
  }

  RED.nodes.registerType('eelectron-knxip-ets', EtsCtor as unknown as () => void);
};

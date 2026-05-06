// eelectron-knxip-scene — typed encoder for KNX scene messages (DPT 17/18).
//
// Pipe its output into a knxip writer; the writer will see msg.payload as a
// pre-encoded APDU value and forward it directly to the bus.
//
// Input shapes accepted:
//   - msg.payload = number (0..63)        → DPT 17.001 (scene number) or DPT 18.001 (activate scene N)
//   - msg.payload = { control: 'activate'|'learn', sceneNumber } → DPT 18.001
//   - msg.payload = { sceneNumber, learn?: bool }                → DPT 18.001
//
// `mode` selects the output DPT explicitly when ambiguous.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import type { APDUValue } from '../../core/apci';
import { getDpt } from '../../dpt';

interface SceneProps {
  groupAddress?: string;
  /** 'auto' picks DPT 18.001 when control info is supplied, else 17.001. */
  mode?: 'auto' | '17.001' | '18.001';
}

type Def = NodeDef & SceneProps;

interface KnxMessage extends NodeMessage {
  topic?: string;
  payload?: unknown;
  dpt?: string;
}

interface SceneInput {
  sceneNumber: number;
  control?: 'activate' | 'learn';
}

function coerce(payload: unknown): SceneInput {
  if (typeof payload === 'number') return { sceneNumber: payload };
  if (payload && typeof payload === 'object') {
    const o = payload as { sceneNumber?: unknown; scene?: unknown; control?: unknown; learn?: unknown };
    const sn =
      typeof o.sceneNumber === 'number'
        ? o.sceneNumber
        : typeof o.scene === 'number'
          ? o.scene
          : null;
    if (sn === null) throw new Error('scene payload must include `sceneNumber` (0..63)');
    let control: 'activate' | 'learn' | undefined;
    if (o.control === 'activate' || o.control === 'learn') control = o.control;
    else if (o.learn === true) control = 'learn';
    return { sceneNumber: sn, ...(control ? { control } : {}) };
  }
  throw new Error(`scene payload must be a number or { sceneNumber, control? }, got ${typeof payload}`);
}

export = function (RED: NodeAPI) {
  function SceneCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const mode = def.mode ?? 'auto';

    const onInput = (
      msg: KnxMessage,
      send: ((m: NodeMessage) => void) | undefined,
      done: ((err?: Error) => void) | undefined,
    ) => {
      try {
        const input = coerce(msg.payload);
        if (input.sceneNumber < 0 || input.sceneNumber > 63 || !Number.isInteger(input.sceneNumber)) {
          throw new Error(`sceneNumber must be integer 0..63, got ${input.sceneNumber}`);
        }
        const useDpt =
          mode === 'auto' ? (input.control ? '18.001' : '17.001') : mode;
        let apdu: APDUValue;
        if (useDpt === '18.001') {
          apdu = getDpt('18.001').encode({
            control: input.control ?? 'activate',
            sceneNumber: input.sceneNumber,
          } as never) as APDUValue;
        } else {
          apdu = getDpt('17.001').encode(input.sceneNumber as never) as APDUValue;
        }
        const out: KnxMessage = {
          ...msg,
          payload: apdu as unknown,
          dpt: useDpt,
          ...(def.groupAddress && !msg.topic ? { topic: def.groupAddress } : {}),
        };
        if (send) send(out as NodeMessage);
        else self.send(out as NodeMessage);
        if (done) done();
      } catch (err) {
        if (done) done(err as Error);
        else self.error((err as Error).message, msg as NodeMessage);
      }
    };

    (self.on as unknown as (event: 'input', cb: typeof onInput) => void)('input', onInput);
  }

  RED.nodes.registerType('eelectron-knxip-scene', SceneCtor as unknown as () => void);
};

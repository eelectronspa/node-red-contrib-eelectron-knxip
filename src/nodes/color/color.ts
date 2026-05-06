// eelectron-knxip-color — typed encoder for KNX colour DPTs (232.600, 251.600).
//
// Pipe its output into a knxip writer; the writer will pass the pre-encoded
// APDU value straight through to the bus.
//
// Accepted input shapes for `msg.payload`:
//   - "#rrggbb" / "#rrggbbww" hex strings
//   - { red, green, blue, white? } / { r, g, b, w? } with 0..255 channels
//   - "rgb(r, g, b)" / "rgba(r, g, b, w)"  — w mapped to white when present

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import type { APDUValue } from '../../core/apci';
import { getDpt } from '../../dpt';

interface ColorProps {
  groupAddress?: string;
  /** 'rgb' = DPT 232.600, 'rgbw' = DPT 251.600. */
  mode?: 'rgb' | 'rgbw';
}

type Def = NodeDef & ColorProps;

interface KnxMessage extends NodeMessage {
  topic?: string;
  payload?: unknown;
  dpt?: string;
}

interface RGBW {
  red: number;
  green: number;
  blue: number;
  white?: number;
}

const HEX_RE = /^#?([0-9a-f]{6})(?:([0-9a-f]{2}))?$/i;
const RGB_FN_RE =
  /^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d{1,3}))?\s*\)$/i;

function clampByte(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got ${v}`);
  const r = Math.round(v);
  if (r < 0 || r > 255) throw new Error(`${name} out of range 0..255: ${v}`);
  return r;
}

function parseColor(payload: unknown): RGBW {
  if (typeof payload === 'string') {
    const hex = HEX_RE.exec(payload.trim());
    if (hex) {
      const rgb = hex[1]!;
      const w = hex[2];
      return {
        red: parseInt(rgb.slice(0, 2), 16),
        green: parseInt(rgb.slice(2, 4), 16),
        blue: parseInt(rgb.slice(4, 6), 16),
        ...(w !== undefined ? { white: parseInt(w, 16) } : {}),
      };
    }
    const fn = RGB_FN_RE.exec(payload.trim());
    if (fn) {
      return {
        red: clampByte(Number(fn[1]), 'red'),
        green: clampByte(Number(fn[2]), 'green'),
        blue: clampByte(Number(fn[3]), 'blue'),
        ...(fn[4] !== undefined ? { white: clampByte(Number(fn[4]), 'white') } : {}),
      };
    }
    throw new Error(`Cannot parse colour string "${payload}"`);
  }
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    const red =
      typeof o.red === 'number' ? o.red : typeof o.r === 'number' ? o.r : NaN;
    const green =
      typeof o.green === 'number' ? o.green : typeof o.g === 'number' ? o.g : NaN;
    const blue =
      typeof o.blue === 'number' ? o.blue : typeof o.b === 'number' ? o.b : NaN;
    const white =
      typeof o.white === 'number' ? o.white : typeof o.w === 'number' ? o.w : undefined;
    return {
      red: clampByte(red, 'red'),
      green: clampByte(green, 'green'),
      blue: clampByte(blue, 'blue'),
      ...(white !== undefined ? { white: clampByte(white, 'white') } : {}),
    };
  }
  throw new Error(`Unsupported colour payload: ${typeof payload}`);
}

export = function (RED: NodeAPI) {
  function ColorCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const mode = def.mode ?? 'rgb';

    const onInput = (
      msg: KnxMessage,
      send: ((m: NodeMessage) => void) | undefined,
      done: ((err?: Error) => void) | undefined,
    ) => {
      try {
        const c = parseColor(msg.payload);
        let apdu: APDUValue;
        let dpt: string;
        if (mode === 'rgbw') {
          apdu = getDpt('251.600').encode({
            red: c.red,
            green: c.green,
            blue: c.blue,
            white: c.white ?? 0,
          } as never) as APDUValue;
          dpt = '251.600';
        } else {
          apdu = getDpt('232.600').encode({
            red: c.red,
            green: c.green,
            blue: c.blue,
          } as never) as APDUValue;
          dpt = '232.600';
        }
        const out: KnxMessage = {
          ...msg,
          payload: apdu as unknown,
          dpt,
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

  RED.nodes.registerType('eelectron-knxip-color', ColorCtor as unknown as () => void);
};

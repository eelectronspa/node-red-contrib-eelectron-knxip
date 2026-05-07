// eelectron-knxip-mqtt-publish — bridge KNX traffic to MQTT.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Drops in between one-or-more `eelectron-knxip-listener` nodes and a single
// `mqtt out` node. Two responsibilities:
//
//   1. Filter — only forward telegrams whose GA exists in the bound ETS
//      project. Telegrams from other projects (or unbound) are dropped.
//      That's the "publish only what I know about" guarantee.
//
//   2. Reshape — build the MQTT-ready message:
//        msg.topic   = rendered topic template
//        msg.payload = rendered payload (per the chosen mode)
//
// The output is whatever a stock `mqtt out` node consumes: `{topic, payload}`.
// All other inbound msg fields are stripped, on purpose — no risk of leaking
// internals (raw APDU, channel ids, …) to the broker.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import { GroupAddress } from '../../core/address';
import {
  type TemplateCtx,
  interpolateString,
  renderJsonTemplate,
} from '../../util/template';
import type { KnxEtsConfigNode } from '../shared/configNode';

interface MqttPublishProps {
  etsConfig: string;
  topicTemplate?: string;
  /** 'value' | 'object' | 'template' */
  payloadMode?: string;
  payloadTemplate?: string;
  /** When true, also forward unknown GAs (just no name/dpt in context). */
  forwardUnknown?: boolean;
}

type Def = NodeDef & MqttPublishProps;

export = function (RED: NodeAPI) {
  function MqttPublishCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.etsConfig) as unknown as
      | (Node & KnxEtsConfigNode)
      | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no ETS config' });
      return;
    }

    const topicTemplate = (def.topicTemplate ?? 'knx/{ga}').trim() || 'knx/{ga}';
    const payloadMode = (def.payloadMode ?? 'object') as 'value' | 'object' | 'template';
    const payloadTemplate = def.payloadTemplate ?? '';
    const forwardUnknown = def.forwardUnknown === true;

    let published = 0;
    let dropped = 0;
    function setStatus(): void {
      self.status({
        fill: 'green',
        shape: 'dot',
        text: `pub ${published} · drop ${dropped}`,
      });
    }
    setStatus();

    self.on('input', (msg: NodeMessage, _send, done) => {
      const m = msg as NodeMessage & {
        dpt?: string;
        gaName?: string;
        knx?: {
          source?: string;
          destination?: string;
          tunnel?: {
            id?: string;
            label?: string;
            gatewayIp?: string;
            gatewayPort?: number;
          };
        };
      };
      const gaStr = typeof m.topic === 'string' ? m.topic : '';
      let entry: ReturnType<KnxEtsConfigNode['map']['get']> = null;
      if (gaStr) {
        try {
          entry = cfg.map.get(new GroupAddress(gaStr));
        } catch {
          entry = null;
        }
      }
      if (!entry && !forwardUnknown) {
        dropped += 1;
        setStatus();
        if (done) done();
        return;
      }

      // Pre-compute a few alternate GA representations so users can pick a
      // topic shape that matches their broker conventions:
      //   - {ga}         → "1/1/29"  (KNX long form; MQTT *will* tree this)
      //   - {gaDots}     → "1.1.29"  (flat, no tree)
      //   - {gaDashes}   → "1-1-29"  (flat, no tree)
      //   - {gaRaw}      → "8221"    (uint16 form; useful for tools that key by raw)
      //   - {gaNameSlug} → "workshop-on-off-status" (lowercased, URL-safe; ideal for HA)
      let gaRaw = '';
      try {
        if (gaStr) gaRaw = String(new GroupAddress(gaStr).raw);
      } catch { /* unparseable — leave blank */ }
      const gaName = entry?.name ?? m.gaName ?? '';
      const gaNameSlug = gaName
        .toLowerCase()
        .replace(/[\s/]+/g, '-')
        .replace(/[^a-z0-9_-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      // Tunnel context — which IP interface the telegram came in through.
      // The listener attaches this; older messages (or non-listener
      // upstreams) might not, so default to empty strings.
      const tunnel = m.knx?.tunnel ?? {};
      const tunnelLabel = tunnel.label ?? '';
      const tunnelIp = tunnel.gatewayIp ?? '';
      const tunnelPort = tunnel.gatewayPort != null ? String(tunnel.gatewayPort) : '';
      const tunnelHost = tunnelIp + (tunnelPort ? ':' + tunnelPort : '');
      // Slugified label for HA / topic-safe usage.
      const tunnelSlug = tunnelLabel
        .toLowerCase()
        .replace(/[\s/]+/g, '-')
        .replace(/[^a-z0-9_.-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      const ctx: TemplateCtx = {
        ga: gaStr,
        gaDots: gaStr.replace(/\//g, '.'),
        gaDashes: gaStr.replace(/\//g, '-'),
        gaRaw,
        gaName,
        gaNameSlug,
        dpt: entry?.dpt ?? m.dpt ?? '',
        source: m.knx?.source ?? '',
        destination: m.knx?.destination ?? gaStr,
        // "tunnel" group — which IP interface this telegram came through.
        tunnel: tunnelLabel,
        tunnelSlug,
        tunnelIp,
        tunnelPort,
        tunnelHost,
        tunnelId: tunnel.id ?? '',
        value: m.payload,
        ts: new Date().toISOString(),
      };

      let topic: string;
      try {
        topic = interpolateString(topicTemplate, ctx);
      } catch (err) {
        self.warn(`topic template failed: ${(err as Error).message}`);
        if (done) done();
        return;
      }

      let payload: unknown;
      if (payloadMode === 'value') {
        payload = m.payload;
      } else if (payloadMode === 'template') {
        const rendered = renderJsonTemplate(payloadTemplate, ctx);
        if (!rendered.ok) {
          self.warn(`payload template failed: ${rendered.error}`);
          if (done) done();
          return;
        }
        payload = rendered.value;
      } else {
        // 'object' default — most useful out-of-the-box shape.
        payload = {
          value: m.payload,
          ga: ctx.ga,
          ...(ctx.gaName ? { gaName: ctx.gaName } : {}),
          ...(ctx.dpt ? { dpt: ctx.dpt } : {}),
          ...(ctx.source ? { source: ctx.source } : {}),
          ts: ctx.ts,
        };
      }

      published += 1;
      setStatus();
      // Build a fresh message — strip every other field deliberately so
      // internal KNX details don't leak to the broker.
      self.send({ topic, payload } as NodeMessage);
      if (done) done();
    });
  }

  RED.nodes.registerType(
    'eelectron-knxip-mqtt-publish',
    MqttPublishCtor as unknown as () => void,
  );
};

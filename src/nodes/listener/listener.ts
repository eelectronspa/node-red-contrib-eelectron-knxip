// eelectron-knxip-listener — subscribes to a set of group addresses and emits
// inbound telegrams as Node-RED messages.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import { GroupAddress, IndividualAddress } from '../../core/address';
import type { APDUValue } from '../../core/apci';
import { CEMIFrame, CEMIMessageCode } from '../../core/cemi';
import { getDpt, hasDpt } from '../../dpt';
import type { KnxConfigNode } from '../shared/configNode';

interface ListenerProps {
  config: string;
  /** Comma- or newline-separated list of group addresses, or a JSON array. */
  groupAddresses?: string | string[];
  dpt?: string;
}

type Def = NodeDef & ListenerProps;

/** KNX priority bits 11..10 of the control field. */
const PRIORITY_NAMES = ['system', 'normal', 'urgent', 'low'] as const;

function parseGroupAddresses(input: ListenerProps['groupAddresses']): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export = function (RED: NodeAPI) {
  function ListenerCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.config) as unknown as (Node & KnxConfigNode) | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }

    let filter: Set<number> | null = null;
    try {
      const list = parseGroupAddresses(def.groupAddresses);
      if (list.length > 0) {
        filter = new Set(list.map((a) => new GroupAddress(a, cfg.groupAddressStyle).raw));
      }
    } catch (err) {
      self.error(`Invalid group address: ${(err as Error).message}`);
      self.status({ fill: 'red', shape: 'ring', text: 'bad GA' });
      return;
    }

    const dptId = def.dpt && hasDpt(def.dpt) ? def.dpt : null;

    const onCemi = (cemi: CEMIFrame) => {
      // We only forward incoming bus telegrams (L_DATA_IND).
      if (cemi.code !== CEMIMessageCode.L_DATA_IND) return;
      const data = cemi.data;
      if (!(data.dstAddr instanceof GroupAddress)) return;
      if (filter && !filter.has(data.dstAddr.raw)) return;
      const apci = data.payload;
      if (!apci) return;
      if (apci.kind !== 'GroupValueWrite' && apci.kind !== 'GroupValueResponse') return;

      const apdu: APDUValue = apci.data;
      let payload: unknown = apdu;
      if (dptId) {
        try {
          payload = getDpt(dptId).decode(apdu);
        } catch (err) {
          self.warn(`DPT ${dptId} decode failed: ${(err as Error).message}`);
          payload = apdu;
        }
      }

      self.send({
        payload,
        topic: data.dstAddr.toString(),
        knx: {
          source: data.srcAddr.toString(),
          destination: data.dstAddr.toString(),
          apci: apci.kind,
          raw: apdu,
          isResponse: apci.kind === 'GroupValueResponse',
          priority: PRIORITY_NAMES[(data.flags & 0x0c00) >> 10] ?? 'unknown',
          tunnel: {
            id: cfg.id,
            label: cfg.gatewayLabel,
            gatewayIp: cfg.gatewayIp,
            gatewayPort: cfg.gatewayPort,
          },
        },
        // satisfy NodeMessage open-shape:
      } as unknown as Parameters<typeof self.send>[0]);
    };

    cfg.client.on('cemi', onCemi);
    cfg.attach(self.id);

    self.on('close', (_removed: boolean, done: () => void) => {
      cfg.client.off('cemi', onCemi);
      cfg.detach(self.id);
      done();
    });

    // Avoid an unused-import lint warning on IndividualAddress (used implicitly via instanceof checks)
    void IndividualAddress;
  }

  RED.nodes.registerType('eelectron-knxip-listener', ListenerCtor as unknown as () => void);
};

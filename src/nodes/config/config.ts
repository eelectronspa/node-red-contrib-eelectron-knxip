// eelectron-knxip-config — config node owning one TunnelClient per instance.
// Multi-tunnel ready: each config node creates its own client with its own
// UDP socket. Children attach to this client; first attach connects, last
// detach disconnects.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import type { GroupAddressStyle } from '../../core/address';
import { type DiscoveryOptions, discoverGateways } from '../../io/discovery';
import { TunnelClient } from '../../io/tunnel';
import type { KnxConfigNode } from '../shared/configNode';
// Eagerly load DPT codecs so they're registered when the package is required.
import '../../dpt';

interface ConfigNodeProps {
  gatewayIp: string;
  gatewayPort?: string | number;
  localIp?: string;
  localPort?: string | number;
  routeBack?: boolean;
  requestedIndividualAddress?: string;
  groupAddressStyle?: GroupAddressStyle;
  autoReconnect?: boolean;
  autoReconnectWaitMs?: string | number;
  heartbeatIntervalMs?: string | number;
}

type Def = NodeDef & ConfigNodeProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export = function (RED: NodeAPI) {
  // Admin endpoint: trigger a multicast discovery and return found gateways.
  // Editor uses this for the "Discover" button in the tunnel-config dialog.
  RED.httpAdmin.post(
    '/eelectron-knxip/discover-gateways',
    RED.auth.needsPermission('flows.write'),
    async (req, res) => {
      const body = (req.body ?? {}) as Partial<DiscoveryOptions>;
      const opts: DiscoveryOptions = {};
      if (typeof body.timeoutMs === 'number') opts.timeoutMs = body.timeoutMs;
      if (typeof body.localAddress === 'string' && body.localAddress) {
        opts.localAddress = body.localAddress;
      }
      try {
        const gateways = await discoverGateways(opts);
        res.json(gateways);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  function KnxConfigCtor(this: Node & KnxConfigNode, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;

    const client = new TunnelClient({
      gatewayIp: def.gatewayIp,
      gatewayPort: toNumber(def.gatewayPort, 3671),
      ...(def.localIp ? { localIp: def.localIp } : {}),
      ...(def.localPort !== undefined && def.localPort !== ''
        ? { localPort: toNumber(def.localPort, 0) }
        : {}),
      ...(def.routeBack !== undefined ? { routeBack: def.routeBack } : {}),
      ...(def.requestedIndividualAddress
        ? { requestedIndividualAddress: def.requestedIndividualAddress }
        : {}),
      autoReconnect: def.autoReconnect ?? true,
      autoReconnectWaitMs: toNumber(def.autoReconnectWaitMs, 3000),
      heartbeatIntervalMs: toNumber(def.heartbeatIntervalMs, 20_000),
      logger: {
        debug: (msg) => self.debug(msg),
        info: (msg) => self.log(msg),
        warn: (msg) => self.warn(msg),
        error: (msg) => self.error(msg),
      },
    });

    // Surface fatal errors at the node level.
    const onError = (err: Error) => self.error(`KNX/IP tunnel error: ${err.message}`);
    client.on('error', onError);

    const refs = new Set<string>();
    self.client = client;
    self.groupAddressStyle = def.groupAddressStyle ?? 'long';

    self.attach = (childId: string) => {
      if (refs.size === 0) {
        client.connect().catch((err: Error) =>
          self.error(`KNX/IP tunnel connect failed: ${err.message}`),
        );
      }
      refs.add(childId);
    };

    self.detach = (childId: string) => {
      refs.delete(childId);
      if (refs.size === 0) {
        client.disconnect().catch((err: Error) =>
          self.warn(`KNX/IP tunnel disconnect: ${err.message}`),
        );
      }
    };

    self.on('close', (_removed: boolean, done: () => void) => {
      refs.clear();
      client.removeAllListeners();
      client
        .disconnect()
        .catch(() => undefined)
        .finally(() => done());
    });
  }

  RED.nodes.registerType('eelectron-knxip-config', KnxConfigCtor as unknown as () => void);
};

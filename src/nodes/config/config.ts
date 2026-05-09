// eelectron-knxip-config — config node owning one TunnelClient per instance.
// Multi-tunnel ready: each config node creates its own client with its own
// UDP socket. Children attach to this client; first attach connects, last
// detach disconnects.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import { GroupAddress, type GroupAddressStyle } from '../../core/address';
import { type APCI, encodeApci } from '../../core/apci';
import type { CEMIFrame } from '../../core/cemi';
import { getDpt, hasDpt } from '../../dpt';
import { type DiscoveryOptions, discoverGateways } from '../../io/discovery';
import { TunnelClient } from '../../io/tunnel';
import {
  busMonitor,
  type TelegramDecoded,
  type TelegramRecord,
} from '../../runtime/busMonitor';
import type { KnxConfigNode, KnxEtsConfigNode } from '../shared/configNode';
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
  /** Force TCP even without Secure. Default: UDP unless `secureEnabled`. */
  transport?: 'udp' | 'tcp';
  /** When true, run the tunnel as KNX/IP Secure (TCP + SECURE_WRAPPER). */
  secureEnabled?: boolean;
  /** Tunnelling user ID (1..127). User 1 = management; configure 2..127 for runtime. */
  secureUserId?: string | number;
}

interface ConfigCredentials {
  /** Plaintext device authentication password (Secure only). */
  deviceAuthPassword?: string;
  /** Plaintext user password (Secure only). */
  userPassword?: string;
}

type Def = NodeDef & ConfigNodeProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export = function (RED: NodeAPI) {
  // ---- Bus-monitor admin endpoints ---------------------------------------
  // GET .../monitor/recent  → JSON snapshot of the in-memory ring buffer.
  // GET .../monitor/stream  → text/event-stream that flushes the buffer on
  //   connect and emits each new telegram. Both are gated on flows.read so
  //   only authenticated editor sessions see live bus traffic.
  RED.httpAdmin.get(
    '/eelectron-knxip/monitor/recent',
    RED.auth.needsPermission('flows.read'),
    (_req, res) => {
      res.json({
        size: busMonitor.size,
        capacity: busMonitor.capacity,
        records: busMonitor.recent(),
      });
    },
  );

  // Per-tunnel diagnostics — counters + last-seen timestamps for every
  // configured tunnel-config in the workspace. The bus-monitor sidebar polls
  // this every couple of seconds; cheap because each `getDiagnostics()` is
  // O(1) field reads.
  RED.httpAdmin.get(
    '/eelectron-knxip/diagnostics',
    RED.auth.needsPermission('flows.read'),
    (_req, res) => {
      const tunnels: Array<Record<string, unknown>> = [];
      RED.nodes.eachNode((cfg: { id: string; type: string; name?: string }) => {
        if (cfg.type !== 'eelectron-knxip-config') return;
        const node = RED.nodes.getNode(cfg.id) as unknown as
          | (KnxConfigNode & { id: string })
          | null;
        if (!node?.client) return;
        try {
          tunnels.push({
            id: cfg.id,
            label: cfg.name || node.client.getDiagnostics().gatewayIp,
            ...node.client.getDiagnostics(),
          });
        } catch {
          /* tunnel mid-construction; skip */
        }
      });
      res.json({ tunnels });
    },
  );

  RED.httpAdmin.get(
    '/eelectron-knxip/monitor/stream',
    RED.auth.needsPermission('flows.read'),
    (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Disable nginx-style proxy buffering so events flow as soon as we
      // write them.
      res.setHeader('X-Accel-Buffering', 'no');
      // Force identity coding — defends against an upstream `compression`
      // middleware grabbing this response and gzip-buffering each event
      // until the buffer fills (which at telegram volume essentially never
      // happens, so the sidebar would freeze after the first message).
      res.setHeader('Content-Encoding', 'identity');
      // Disable Node's socket-level idle timeout for this long-lived
      // connection. (`req.socket` exists on the Node http API; the cast
      // keeps both Express types happy.)
      const sock = (req as unknown as { socket?: { setTimeout?: (ms: number) => void } }).socket;
      if (sock?.setTimeout) sock.setTimeout(0);
      res.flushHeaders?.();

      // Some proxies wait for the first chunk before forwarding headers;
      // a comment line is harmless and makes the stream open immediately.
      const flushNow = () => {
        // `res.flush` is added by the express `compression` middleware; on a
        // plain stack it doesn't exist. Either way, write it as a separate
        // HTTP/1.1 chunk so the browser sees it immediately.
        const r = res as unknown as { flush?: () => void };
        if (typeof r.flush === 'function') r.flush();
      };

      const writeData = (payload: string) => {
        res.write(payload);
        flushNow();
      };

      writeData(': monitor stream open\n\n');

      // Flush whatever's buffered first so a freshly-opened sidebar shows
      // recent history without waiting for new traffic.
      for (const record of busMonitor.recent()) {
        writeData(`data: ${JSON.stringify(record)}\n\n`);
      }

      const onTelegram = (record: TelegramRecord) => {
        writeData(`data: ${JSON.stringify(record)}\n\n`);
      };
      const onCleared = () => {
        writeData('event: cleared\ndata: {}\n\n');
      };
      busMonitor.on('telegram', onTelegram);
      busMonitor.on('cleared', onCleared);

      // Heartbeat keeps proxies from killing an "idle" connection. 10 s is
      // tighter than typical proxy idle timeouts (30 s / 60 s) so we always
      // keep the path warm. SSE comment lines (starting with `:`) are
      // ignored by the browser.
      const heartbeat = setInterval(() => writeData(': heartbeat\n\n'), 10_000);
      heartbeat.unref?.();

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        busMonitor.off('telegram', onTelegram);
        busMonitor.off('cleared', onCleared);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      // `res.on('close')` covers cases where Node tears the response down
      // independently of the request (e.g. proxy hang-up).
      res.on('close', cleanup);
      res.on('error', cleanup);
    },
  );

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

    const creds = ((self as unknown as { credentials?: ConfigCredentials })
      .credentials ?? {}) as ConfigCredentials;

    // Secure tunneling forces TCP per KNX/IP Secure spec.
    const useSecure = def.secureEnabled === true;
    const transportMode: 'udp' | 'tcp' = useSecure
      ? 'tcp'
      : def.transport === 'tcp'
        ? 'tcp'
        : 'udp';

    let secureOpts:
      | { userId: number; deviceAuthPassword?: string; userPassword: string }
      | undefined;
    if (useSecure) {
      const userId = toNumber(def.secureUserId, 2);
      const deviceAuthPassword = creds.deviceAuthPassword ?? '';
      const userPassword = creds.userPassword ?? '';
      if (!userPassword) {
        self.warn(
          'KNX/IP Secure enabled but user password is empty — connection will fail',
        );
      }
      // Device auth password is optional: non-ETS / single-password
      // devices don't expose a Device Authentication Code. When omitted, the
      // SESSION_RESPONSE MAC check is skipped (server identity unverified)
      // but the encrypted session and client-side authentication still work.
      secureOpts = {
        userId,
        userPassword,
        ...(deviceAuthPassword ? { deviceAuthPassword } : {}),
      };
    }

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
      transport: transportMode,
      ...(secureOpts ? { secure: secureOpts } : {}),
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

    // Bus-monitor wiring — push every inbound CEMI to the singleton so the
    // editor sidebar shows a live trace.
    const tunnelLabel = def.name && def.name.trim()
      ? def.name
      : `${def.gatewayIp}:${toNumber(def.gatewayPort, 3671)}`;
    const onCemi = (cemi: CEMIFrame) => {
      try {
        busMonitor.push(buildTelegramRecord(RED, self.id, tunnelLabel, cemi));
      } catch (err) {
        self.debug(`bus-monitor push failed: ${(err as Error).message}`);
      }
    };
    client.on('cemi', onCemi);

    const refs = new Set<string>();
    self.client = client;
    self.groupAddressStyle = def.groupAddressStyle ?? 'long';
    self.gatewayLabel = tunnelLabel;
    self.gatewayIp = def.gatewayIp;
    self.gatewayPort = toNumber(def.gatewayPort, 3671);

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

  RED.nodes.registerType('eelectron-knxip-config', KnxConfigCtor as unknown as () => void, {
    credentials: {
      deviceAuthPassword: { type: 'password' },
      userPassword: { type: 'password' },
    },
  });
};

/**
 * Assemble a TelegramRecord from a freshly-received CEMI. Best-effort: when
 * the inner APDU doesn't decode to a known APCI we still surface raw bytes
 * so the sidebar shows *something* rather than dropping the line. When any
 * ETS config in the workspace knows the destination GA, we attach a decoded
 * value (with unit, when the codec exposes one) so the sidebar can show the
 * physical reading instead of opaque hex.
 */
function buildTelegramRecord(
  RED: NodeAPI,
  tunnelId: string,
  tunnelLabel: string,
  cemi: CEMIFrame,
): TelegramRecord {
  const data = cemi.data;
  const source = data?.srcAddr ? data.srcAddr.toString() : null;
  const destination = data?.dstAddr ? data.dstAddr.toString() : null;
  let apci = 'other';
  let raw = '';
  let decoded: TelegramDecoded | undefined;
  if (data?.payload) {
    apci = data.payload.kind;
    try {
      raw = encodeApci(data.payload).toString('hex');
    } catch {
      // Encode failure shouldn't drop the record — leave raw empty.
    }
    if (destination) {
      decoded = decodeAgainstEtsConfigs(RED, destination, data.payload) ?? undefined;
    }
  }
  return {
    ts: Date.now(),
    tunnelId,
    tunnelLabel,
    direction: 'in',
    source,
    destination,
    apci,
    raw,
    ...(decoded ? { decoded } : {}),
  };
}

/**
 * Walk every loaded ETS config node in the runtime, find the first one that
 * knows the given destination GA + has a registered DPT codec, and decode
 * the APDU value with it. Returns null if no map matches or the APCI doesn't
 * carry a value (e.g. GroupValueRead).
 */
function decodeAgainstEtsConfigs(
  RED: NodeAPI,
  destination: string,
  apci: APCI,
): TelegramDecoded | null {
  // GroupValueRead has no payload — nothing to decode.
  if (apci.kind !== 'GroupValueWrite' && apci.kind !== 'GroupValueResponse') {
    return null;
  }
  const apduValue = apci.data;
  let ga: GroupAddress;
  try {
    ga = new GroupAddress(destination);
  } catch {
    return null;
  }
  let matched: TelegramDecoded | null = null;
  RED.nodes.eachNode((cfg: { id: string; type: string }) => {
    if (matched) return;
    if (cfg.type !== 'eelectron-knxip-ets-config') return;
    const node = RED.nodes.getNode(cfg.id) as unknown as KnxEtsConfigNode | null;
    if (!node?.map) return;
    const entry = node.map.get(ga);
    if (!entry || !entry.dpt || !hasDpt(entry.dpt)) return;
    try {
      const codec = getDpt(entry.dpt);
      const value = codec.decode(apduValue);
      matched = {
        value,
        dpt: entry.dpt,
        ...(entry.name ? { gaName: entry.name } : {}),
        ...(codec.unit ? { unit: codec.unit } : {}),
      };
    } catch {
      // codec threw — leave matched null and try next config (rare)
    }
  });
  return matched;
}

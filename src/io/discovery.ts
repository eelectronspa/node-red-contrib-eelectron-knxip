// KNX/IP gateway discovery via SEARCH_REQUEST multicast.
//
// Workflow:
//  1. Open a UDP4 socket bound to an ephemeral port.
//  2. Join the KNX/IP multicast group (224.0.23.12:3671 by default).
//  3. Send a SEARCH_REQUEST with a route-back HPAI; gateways reply unicast on
//     the source endpoint of the request.
//  4. Collect SEARCH_RESPONSE datagrams until `timeoutMs` elapses, dedupe by
//     control-endpoint address, return.

import dgram from 'node:dgram';
import { SearchRequest, SearchResponse } from '../core/bodies';
import { HPAI } from '../core/hpai';
import { KNXIPFrame } from '../core/knxipFrame';
import { KNX_MULTICAST_GROUP, KNX_PORT } from './const';

export interface DiscoveredGateway {
  /** IP address of the gateway's control endpoint (where to send CONNECT_REQUEST). */
  address: string;
  /** Port of the gateway's control endpoint. */
  port: number;
  /** Friendly device name from the device-info DIB (often blank on older devices). */
  friendlyName: string;
  /** Assigned individual address of the gateway, when reported. */
  individualAddress?: string;
  /** KNX serial number (12 lowercase hex chars), when reported. */
  serial?: string;
  /** Hardware MAC address of the gateway. */
  macAddress?: string;
  /** Routing multicast advertised by the gateway. */
  multicastAddress?: string;
  /** KNX medium code (2=TP1, 0x10=RF, 0x20=KNX/IP, ...). */
  knxMedium?: number;
}

export interface DiscoveryOptions {
  /** How long to listen for responses before resolving. Default 3000 ms. */
  timeoutMs?: number;
  /** Multicast group to query. Default 224.0.23.12. */
  multicastGroup?: string;
  /** Multicast port. Default 3671. */
  multicastPort?: number;
  /**
   * Specific local interface IP to bind. Useful on multi-homed hosts where the
   * default outgoing interface isn't the LAN with KNX gateways. Default: OS choice.
   */
  localAddress?: string;
}

export async function discoverGateways(
  opts: DiscoveryOptions = {},
): Promise<DiscoveredGateway[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const mcastGroup = opts.multicastGroup ?? KNX_MULTICAST_GROUP;
  const mcastPort = opts.multicastPort ?? KNX_PORT;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map<string, DiscoveredGateway>();

  return new Promise<DiscoveredGateway[]>((resolve, reject) => {
    let settled = false;
    const settle = (
      action: 'resolve' | 'reject',
      value?: DiscoveredGateway[] | Error,
    ) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      if (action === 'reject') reject(value as Error);
      else resolve(value as DiscoveredGateway[]);
    };

    socket.on('error', (err) => settle('reject', err));

    socket.on('message', (data, _rinfo) => {
      try {
        const { frame } = KNXIPFrame.fromKnx(data);
        if (!(frame.body instanceof SearchResponse)) return;
        const ep = frame.body.controlEndpoint;
        const key = `${ep.ip}:${ep.port}`;
        if (found.has(key)) return;
        const di = frame.body.deviceInfo;
        const entry: DiscoveredGateway = {
          address: ep.ip,
          port: ep.port,
          friendlyName: di?.friendlyName ?? '',
          ...(di?.individualAddress
            ? { individualAddress: di.individualAddress.toString() }
            : {}),
          ...(di?.serial ? { serial: di.serial } : {}),
          ...(di?.macAddress ? { macAddress: di.macAddress } : {}),
          ...(di?.multicastAddress ? { multicastAddress: di.multicastAddress } : {}),
          ...(di?.knxMedium !== undefined ? { knxMedium: di.knxMedium } : {}),
        };
        found.set(key, entry);
      } catch {
        // Ignore malformed datagrams or unsupported service types.
      }
    });

    socket.once('listening', () => {
      try {
        socket.setMulticastTTL(8);
        socket.addMembership(mcastGroup, opts.localAddress);
      } catch (err) {
        settle('reject', err as Error);
        return;
      }
      // Send SEARCH_REQUEST with a route-back HPAI — gateway replies on the
      // source endpoint, no need to know our public IP.
      const req = new SearchRequest({ controlEndpoint: HPAI.routeBack() });
      const buf = KNXIPFrame.fromBody(req).toKnx();
      socket.send(buf, mcastPort, mcastGroup, (err) => {
        if (err) settle('reject', err);
      });
      const timer = setTimeout(() => settle('resolve', [...found.values()]), timeoutMs);
      timer.unref?.();
    });

    socket.bind({
      port: 0,
      ...(opts.localAddress !== undefined ? { address: opts.localAddress } : {}),
    });
  });
}

// Shared types/helpers for the Node-RED node integration. The config node
// owns the TunnelClient; child nodes (listener, writer, status) attach to it
// and unsubscribe in their `'close'` handler.
//
// Lifecycle/multi-tunnel notes: every config-node instance has its own
// TunnelClient with its own UDP socket and sequence counters. This file holds
// only types, no module-level state.

import type { GroupAddressStyle } from '../../core/address';
import type { KnxprojSecureInterface } from '../../ets/knxproj';
import type { ETSProjectMap } from '../../ets/projectMap';
import type { TunnelClient } from '../../io/tunnel';

export interface KnxConfigNode {
  /** Underlying tunnel — child nodes subscribe to its events directly. */
  client: TunnelClient;
  /** GA formatting style chosen in the editor. Used by listener/writer to parse user input. */
  groupAddressStyle: GroupAddressStyle;
  /**
   * User-facing label — the node `name` if set, falling back to
   * `gatewayIp:gatewayPort`. Surfaced by listener output as `msg.knx.tunnel.label`
   * so downstream nodes (notably mqtt-publish) can route or label by source.
   */
  gatewayLabel: string;
  /** Configured gateway IPv4 address. */
  gatewayIp: string;
  /** Configured gateway port (defaults to 3671). */
  gatewayPort: number;
  /** Connect-on-first-attach / disconnect-on-last-detach ref-counting. */
  attach(childId: string): void;
  detach(childId: string): void;
}

export interface KnxEtsConfigNode {
  map: ETSProjectMap;
  entryCount: number;
  /**
   * Secure-tunneling credentials extracted from the .knxproj at upload time,
   * if any. Held in memory only — sourced from `credentials.knxprojSecureInfo`
   * (encrypted at rest in Node-RED's credentials file). Read by the
   * tunnel-config editor through an admin endpoint to auto-fill the secure
   * password fields.
   */
  secureInterfaces: KnxprojSecureInterface[];
}

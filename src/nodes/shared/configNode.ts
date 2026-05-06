// Shared types/helpers for the Node-RED node integration. The config node
// owns the TunnelClient; child nodes (listener, writer, status) attach to it
// and unsubscribe in their `'close'` handler.
//
// Lifecycle/multi-tunnel notes: every config-node instance has its own
// TunnelClient with its own UDP socket and sequence counters. This file holds
// only types, no module-level state.

import type { GroupAddressStyle } from '../../core/address';
import type { ETSProjectMap } from '../../ets/projectMap';
import type { TunnelClient } from '../../io/tunnel';

export interface KnxConfigNode {
  /** Underlying tunnel — child nodes subscribe to its events directly. */
  client: TunnelClient;
  /** GA formatting style chosen in the editor. Used by listener/writer to parse user input. */
  groupAddressStyle: GroupAddressStyle;
  /** Connect-on-first-attach / disconnect-on-last-detach ref-counting. */
  attach(childId: string): void;
  detach(childId: string): void;
}

export interface KnxEtsConfigNode {
  map: ETSProjectMap;
  entryCount: number;
}

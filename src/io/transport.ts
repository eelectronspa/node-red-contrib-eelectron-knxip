// Common Transport interface shared by UdpTransport, TcpTransport, and the
// SecureSession wrapper. Lets TunnelClient operate against whatever produces
// (or accepts) plaintext KNXIPFrame objects on the same event surface.

import type { EventEmitter } from 'node:events';
import type { KNXIPFrame } from '../core/knxipFrame';
import type { SocketAddress } from './udpTransport';

export interface Transport extends EventEmitter {
  /**
   * Open the underlying socket / connection / secure session and resolve with
   * the local socket address (or a route-back-style placeholder for secure
   * sessions where the local address isn't directly user-visible).
   */
  bind(): Promise<SocketAddress>;
  /** Send a plaintext KNX/IP frame. */
  send(frame: KNXIPFrame, addr?: SocketAddress): Promise<void>;
  /** Tear down. Idempotent. */
  close(): Promise<void>;
}

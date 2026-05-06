// Thin wrapper around dgram.Socket that parses inbound KNX/IP frames and
// promisifies bind/send/close. One Socket per UdpTransport — owned exclusively
// by the TunnelClient that creates it.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { CouldNotParseKNXIP, IncompleteKNXIPFrame, UnsupportedKNXIPService } from '../core/errors';
import { KNXIPFrame } from '../core/knxipFrame';

export interface SocketAddress {
  address: string;
  port: number;
}

export interface UdpTransportOptions {
  remoteAddress: string;
  remotePort: number;
  /** Local IPv4 address to bind to. Defaults to OS choice (0.0.0.0). */
  localAddress?: string;
  /** Local UDP port. Defaults to 0 (OS-assigned). */
  localPort?: number;
}

export interface UdpTransportEvents {
  /** Successfully parsed inbound KNX/IP frame. */
  message: (frame: KNXIPFrame, source: SocketAddress) => void;
  /**
   * Inbound datagram that didn't parse. Emitted instead of `'error'` so a stray
   * non-KNX-IP packet on a shared port doesn't tear down the transport.
   */
  raw: (data: Buffer, source: SocketAddress, error: Error) => void;
  /** Underlying socket error. */
  error: (err: Error) => void;
  /** Socket closed (after `close()` resolves or external close). */
  close: () => void;
}

export class UdpTransport extends EventEmitter {
  private readonly _opts: UdpTransportOptions;
  private _socket: dgram.Socket | null = null;
  private _bound: SocketAddress | null = null;
  private _closed = false;

  constructor(opts: UdpTransportOptions) {
    super();
    this._opts = opts;
  }

  get bound(): SocketAddress | null {
    return this._bound;
  }

  /** Open the socket and bind. Resolves with the bound local address. */
  bind(): Promise<SocketAddress> {
    if (this._socket) {
      return Promise.reject(new Error('UdpTransport already bound'));
    }
    if (this._closed) {
      return Promise.reject(new Error('UdpTransport already closed'));
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    this._socket = socket;

    // Always attach error handler before any other socket op — dgram crashes the
    // process on async errors with no listener.
    socket.on('error', (err) => this.emit('error', err));

    socket.on('message', (data, rinfo) => {
      const source: SocketAddress = { address: rinfo.address, port: rinfo.port };
      try {
        const { frame } = KNXIPFrame.fromKnx(data);
        this.emit('message', frame, source);
      } catch (err) {
        if (
          err instanceof CouldNotParseKNXIP ||
          err instanceof IncompleteKNXIPFrame ||
          err instanceof UnsupportedKNXIPService
        ) {
          this.emit('raw', data, source, err as Error);
          return;
        }
        // Anything else is an unexpected programmer/runtime error — surface it.
        this.emit('error', err as Error);
      }
    });

    socket.on('close', () => this.emit('close'));

    return new Promise<SocketAddress>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        socket.off('error', onError);
        const addr = socket.address();
        this._bound = { address: addr.address, port: addr.port };
        resolve(this._bound);
      };
      socket.once('listening', onListening);
      socket.once('error', onError);
      socket.bind({
        address: this._opts.localAddress,
        port: this._opts.localPort ?? 0,
      });
    });
  }

  /** Send a frame. If `addr` is omitted, sends to the configured remote endpoint. */
  send(frame: KNXIPFrame, addr?: SocketAddress): Promise<void> {
    if (this._closed) return Promise.reject(new Error('UdpTransport is closed'));
    const socket = this._socket;
    if (!socket) return Promise.reject(new Error('UdpTransport not bound'));

    const buf = frame.toKnx();
    const target = addr ?? { address: this._opts.remoteAddress, port: this._opts.remotePort };
    return new Promise<void>((resolve, reject) => {
      socket.send(buf, target.port, target.address, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Close the socket. Idempotent. Resolves once `'close'` fires. */
  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    const socket = this._socket;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  }
}

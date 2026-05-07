// Streaming TCP transport for KNX/IP. Required for Secure Tunneling (the
// spec mandates TCP for the secure flavour; classic UDP tunneling can keep
// using `UdpTransport`).
//
// Unlike UDP datagrams, TCP gives us a byte stream — segments can be split
// or coalesced arbitrarily. We accumulate received bytes and use the 6-byte
// KNX/IP header (specifically `totalLength`) to slice them into complete
// frames before emitting `message`.

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { CouldNotParseKNXIP, IncompleteKNXIPFrame, UnsupportedKNXIPService } from '../core/errors';
import { KNXIPFrame } from '../core/knxipFrame';
import { KNXIPHeader } from '../core/knxipHeader';
import type { SocketAddress } from './udpTransport';

export interface TcpTransportOptions {
  remoteAddress: string;
  remotePort: number;
  /** Optional connect timeout in ms. Defaults to 10 000. */
  connectTimeoutMs?: number;
}

export interface TcpTransportEvents {
  message: (frame: KNXIPFrame, source: SocketAddress) => void;
  raw: (data: Buffer, source: SocketAddress, error: Error) => void;
  error: (err: Error) => void;
  close: () => void;
}

export class TcpTransport extends EventEmitter {
  private readonly _opts: TcpTransportOptions;
  private _socket: net.Socket | null = null;
  private _localAddr: SocketAddress | null = null;
  private _closed = false;
  // Explicit Buffer annotation: under @types/node 22+ the unannotated form
  // narrows to `Buffer<ArrayBuffer>`, which then refuses re-assignment from
  // `Buffer.concat()` results (typed as `Buffer<ArrayBufferLike>`).
  private _rxBuf: Buffer = Buffer.alloc(0);

  constructor(opts: TcpTransportOptions) {
    super();
    this._opts = opts;
  }

  get localAddress(): SocketAddress | null {
    return this._localAddr;
  }

  /** Establish the TCP connection. Resolves with the local socket address. */
  bind(): Promise<SocketAddress> {
    if (this._socket) return Promise.reject(new Error('TcpTransport already connected'));
    if (this._closed) return Promise.reject(new Error('TcpTransport closed'));

    const socket = new net.Socket();
    this._socket = socket;
    socket.on('error', (err) => this.emit('error', err));
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => {
      this._closed = true;
      this.emit('close');
    });

    return new Promise<SocketAddress>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`TCP connect timeout to ${this._opts.remoteAddress}:${this._opts.remotePort}`));
      }, this._opts.connectTimeoutMs ?? 10_000);
      timer.unref?.();

      const onConnect = () => {
        cleanup();
        const addr = socket.address();
        if (addr && typeof addr === 'object' && 'port' in addr) {
          this._localAddr = { address: (addr as net.AddressInfo).address, port: (addr as net.AddressInfo).port };
        } else {
          this._localAddr = { address: '0.0.0.0', port: 0 };
        }
        resolve(this._localAddr);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect({ host: this._opts.remoteAddress, port: this._opts.remotePort });
    });
  }

  send(frame: KNXIPFrame, _addr?: SocketAddress): Promise<void> {
    if (this._closed) return Promise.reject(new Error('TcpTransport is closed'));
    const sock = this._socket;
    if (!sock) return Promise.reject(new Error('TcpTransport not connected'));
    const buf = frame.toKnx();
    return new Promise<void>((resolve, reject) => {
      sock.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    const sock = this._socket;
    if (!sock) return Promise.resolve();
    return new Promise<void>((resolve) => {
      sock.once('close', () => resolve());
      sock.end(() => sock.destroy());
    });
  }

  private _onData(chunk: Buffer): void {
    this._rxBuf = this._rxBuf.length === 0 ? chunk : Buffer.concat([this._rxBuf, chunk]);

    // Process all complete frames sitting in the buffer, leaving any partial
    // tail for the next chunk.
    while (this._rxBuf.length >= KNXIPHeader.LENGTH) {
      let totalLen: number;
      try {
        // We only need totalLength to know how much to slice. Parsing the
        // header here is cheap; mis-formed headers will surface as an emit on
        // 'raw' below and we resync by discarding the byte that broke us.
        const { header } = KNXIPHeader.fromKnx(this._rxBuf);
        totalLen = header.totalLength;
      } catch (err) {
        if (err instanceof IncompleteKNXIPFrame) return; // wait for more bytes
        // Header looked malformed. Surface as 'raw' and skip a byte to try
        // to resync — better than getting stuck.
        const source = this._sourceFromSocket();
        this.emit('raw', Buffer.from(this._rxBuf.subarray(0, KNXIPHeader.LENGTH)), source, err as Error);
        this._rxBuf = Buffer.from(this._rxBuf.subarray(1));
        continue;
      }

      if (totalLen < KNXIPHeader.LENGTH || totalLen > this._rxBuf.length) {
        if (totalLen > this._rxBuf.length) return; // not enough data yet
        // totalLen smaller than the header — pathological. Resync by 1 byte.
        const source = this._sourceFromSocket();
        this.emit(
          'raw',
          Buffer.from(this._rxBuf.subarray(0, KNXIPHeader.LENGTH)),
          source,
          new CouldNotParseKNXIP(`bogus totalLength ${totalLen}`),
        );
        this._rxBuf = Buffer.from(this._rxBuf.subarray(1));
        continue;
      }

      const frameBytes = Buffer.from(this._rxBuf.subarray(0, totalLen));
      this._rxBuf = Buffer.from(this._rxBuf.subarray(totalLen));

      try {
        const { frame } = KNXIPFrame.fromKnx(frameBytes);
        this.emit('message', frame, this._sourceFromSocket());
      } catch (err) {
        const source = this._sourceFromSocket();
        if (
          err instanceof CouldNotParseKNXIP ||
          err instanceof UnsupportedKNXIPService ||
          err instanceof IncompleteKNXIPFrame
        ) {
          this.emit('raw', frameBytes, source, err as Error);
        } else {
          this.emit('error', err as Error);
        }
      }
    }
  }

  private _sourceFromSocket(): SocketAddress {
    const sock = this._socket;
    return {
      address: sock?.remoteAddress ?? this._opts.remoteAddress,
      port: sock?.remotePort ?? this._opts.remotePort,
    };
  }
}

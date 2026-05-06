// KNX/IP UDP tunnel client. State machine + send mutex + heartbeat + auto-reconnect.
//
// Lifecycle: disconnected → connecting → connected → disconnecting → disconnected.
//
// Send path is serialised — only one TUNNELLING_REQUEST is in flight at a time
// because the gateway tracks a single sequence counter and the spec requires
// awaiting the ACK before the next send.
//
// All state lives on the instance — no module-level singletons. Multiple
// TunnelClient instances coexist on different gateways/ports without interference.

import { EventEmitter } from 'node:events';
import { IndividualAddress, type IndividualAddressInput } from '../core/address';
import {
  type APDUValue,
  groupValueRead,
  groupValueWrite,
} from '../core/apci';
import {
  ConnectRequest,
  ConnectResponse,
  ConnectionStateRequest,
  ConnectionStateResponse,
  DisconnectRequest,
  DisconnectResponse,
  TunnellingAck,
  TunnellingRequest,
} from '../core/bodies';
import { CEMIFrame, CEMILData, CEMIFlags, CEMIMessageCode, DEFAULT_OUTGOING_FLAGS } from '../core/cemi';
import { CRI } from '../core/cri';
import { GroupAddress, type GroupAddressInput } from '../core/address';
import { HPAI } from '../core/hpai';
import { KNXIPFrame } from '../core/knxipFrame';
import { ConnectionType, ErrorCode, errorCodeName } from '../core/serviceTypes';
import { defaultTpci } from '../core/telegram';
import {
  AUTO_RECONNECT_WAIT_MS,
  CONNECT_REQUEST_TIMEOUT_MS,
  CONNECTIONSTATE_REQUEST_TIMEOUT_MS,
  HEARTBEAT_MAX_FAILURES,
  HEARTBEAT_RATE_MS,
  KNX_PORT,
  TUNNELLING_REQUEST_TIMEOUT_MS,
} from './const';
import { SerialQueue } from './serialQueue';
import { type SocketAddress, UdpTransport } from './udpTransport';

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export interface TunnelClientOptions {
  gatewayIp: string;
  gatewayPort?: number;
  /** Local IPv4 to bind to. When omitted, route-back is used (HPAI 0.0.0.0:0). */
  localIp?: string;
  localPort?: number;
  /** Force-override route-back. If undefined, derived from `localIp`. */
  routeBack?: boolean;
  /** Requested individual address for the assigned tunnel (extended CRI). */
  requestedIndividualAddress?: IndividualAddressInput;
  /** Auto-reconnect on tunnel loss. Default: true. */
  autoReconnect?: boolean;
  /** Delay between reconnect attempts. Default: 3000 ms. */
  autoReconnectWaitMs?: number;
  /** Heartbeat cadence. Default: 20000 ms (tighter than xknx). */
  heartbeatIntervalMs?: number;
  /** Logger sink. Defaults to no-op. */
  logger?: TunnelLogger;
}

export interface TunnelLogger {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
}

/**
 * Communication-layer error: tunnel lost, ACK timeout exhausted, response
 * status non-zero, etc. Distinct from parser errors.
 */
export class CommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunicationError';
  }
}

export class TunnellingAckError extends CommunicationError {
  constructor(message: string) {
    super(message);
    this.name = 'TunnellingAckError';
  }
}

interface PendingAck {
  sequence: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingResponse<T> {
  expectedServiceType: number;
  resolve: (body: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TunnelClientEvents {
  state: (state: TunnelState, prev: TunnelState) => void;
  cemi: (cemi: CEMIFrame) => void;
  warning: (err: Error) => void;
  /** Fatal error after auto-reconnect was disabled or exhausted. */
  error: (err: Error) => void;
}

const noopLogger: Required<TunnelLogger> = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class TunnelClient extends EventEmitter {
  private readonly _opts: Required<
    Pick<
      TunnelClientOptions,
      | 'gatewayIp'
      | 'gatewayPort'
      | 'autoReconnect'
      | 'autoReconnectWaitMs'
      | 'heartbeatIntervalMs'
    >
  > &
    TunnelClientOptions;
  private readonly _logger: Required<TunnelLogger>;

  private _state: TunnelState = 'disconnected';
  private _transport: UdpTransport | null = null;
  private _channelId: number | null = null;
  private _localHpai: HPAI = HPAI.routeBack();
  /** Where to send TUNNELLING_REQUESTs (null = back to gatewayIp:gatewayPort). */
  private _dataEndpoint: SocketAddress | null = null;
  private _assignedAddress: IndividualAddress | null = null;

  private _seqOut = 0;
  private _seqIn = 0;

  private _pendingAck: PendingAck | null = null;
  // Allow any body type because we await different types; cast at the call site.
  private _pendingResponse: PendingResponse<unknown> | null = null;

  private _heartbeatTimer: NodeJS.Timeout | null = null;
  private _invalidSeqTimer: NodeJS.Timeout | null = null;
  private _reconnectPromise: Promise<void> | null = null;
  private _reconnectAbort = false;

  private readonly _sendQueue = new SerialQueue();

  /** Tunnel-builder transport factory (overridable for tests). */
  private readonly _transportFactory: (opts: TunnelClientOptions) => UdpTransport;

  constructor(
    opts: TunnelClientOptions,
    transportFactory: (opts: TunnelClientOptions) => UdpTransport = defaultTransportFactory,
  ) {
    super();
    this._opts = {
      gatewayPort: KNX_PORT,
      autoReconnect: true,
      autoReconnectWaitMs: AUTO_RECONNECT_WAIT_MS,
      heartbeatIntervalMs: HEARTBEAT_RATE_MS,
      ...opts,
    };
    this._logger = { ...noopLogger, ...opts.logger };
    this._transportFactory = transportFactory;
  }

  get state(): TunnelState {
    return this._state;
  }

  get assignedAddress(): IndividualAddress | null {
    return this._assignedAddress;
  }

  get sendQueueDepth(): number {
    return this._sendQueue.depth;
  }

  // ---------- public API ----------

  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    if (this._state !== 'disconnected') {
      throw new CommunicationError(`connect() called in state ${this._state}`);
    }
    this._setState('connecting');

    try {
      await this._openTransport();
      await this._sendConnectRequest();
    } catch (err) {
      this._logger.debug('Connect failed', err);
      await this._teardownTransport();
      this._setState('disconnected');
      throw err instanceof CommunicationError
        ? err
        : new CommunicationError(`Tunnel connection failed: ${(err as Error).message}`);
    }

    this._seqOut = 0;
    this._seqIn = 0;
    this._startHeartbeat();
    this._setState('connected');
  }

  async disconnect(): Promise<void> {
    if (this._state === 'disconnected') return;
    this._reconnectAbort = true;
    if (this._reconnectPromise) {
      try {
        await this._reconnectPromise;
      } catch {
        /* swallow */
      }
    }

    // _state may have flipped to 'disconnected' from inside the reconnect loop's
    // own _onTunnelLost; cast through unknown to drop the narrowed type.
    if ((this._state as unknown as TunnelState) === 'disconnected') return;

    this._setState('disconnecting');
    this._stopHeartbeat();
    this._cancelInvalidSeqTimer();
    // reject anything that was queued waiting on us so callers don't hang
    this._rejectPendingAck(new CommunicationError('Tunnel disconnecting'));
    this._rejectPendingResponse(new CommunicationError('Tunnel disconnecting'));

    try {
      if (this._channelId !== null && this._transport) {
        await this._sendDisconnectRequest();
      }
    } catch (err) {
      this._logger.warn('Disconnect request failed', err);
    } finally {
      await this._teardownTransport();
      this._channelId = null;
      this._dataEndpoint = null;
      this._assignedAddress = null;
      this._setState('disconnected');
      this._reconnectAbort = false;
    }
  }

  /**
   * Send a CEMI frame as a TUNNELLING_REQUEST. Resolves on TUNNELLING_ACK,
   * rejects on exhausted retries.
   */
  sendCemi(cemi: CEMIFrame): Promise<void> {
    return this._sendQueue.run(async () => {
      // If the tunnel is reconnecting when we're picked, wait for it.
      if (this._reconnectPromise) {
        try {
          await this._reconnectPromise;
        } catch {
          /* connect() failure already surfaced via 'error' or rejected pending */
        }
      }
      if (this._state !== 'connected') {
        throw new CommunicationError(
          `Cannot sendCemi in state '${this._state}'`,
        );
      }
      const rawCemi = cemi.toKnx();
      try {
        await this._tunnellingRequestOnce(rawCemi);
        return;
      } catch (err) {
        this._logger.debug('First TUNNELLING_REQUEST attempt failed', err);
      }
      // retry once with same sequence
      try {
        await this._tunnellingRequestOnce(rawCemi);
        return;
      } catch (err) {
        this._logger.debug('Second TUNNELLING_REQUEST attempt failed', err);
      }
      // increment seq, declare tunnel lost, and either reconnect-and-retry or fail
      this._bumpSeqOut();
      const giveUp = new CommunicationError(
        'TUNNELLING_REQUEST failed twice; tunnel considered lost',
      );
      if (!this._opts.autoReconnect) {
        this._onTunnelLost(giveUp);
        throw giveUp;
      }
      this._onTunnelLost(giveUp);
      try {
        await this._reconnectPromise;
      } catch (err) {
        throw new CommunicationError(
          `Reconnect failed after send retries: ${(err as Error).message}`,
        );
      }
      // After reconnect, _seqOut was reset to 0 and we already bumped above —
      // resend with the new starting sequence.
      try {
        await this._tunnellingRequestOnce(rawCemi);
      } catch (err) {
        throw new CommunicationError(
          `Third TUNNELLING_REQUEST attempt failed after reconnect: ${(err as Error).message}`,
        );
      }
    });
  }

  /** Convenience: GroupValueWrite. */
  groupValueWrite(destination: GroupAddressInput, value: APDUValue): Promise<void> {
    const dst = new GroupAddress(destination);
    const cemi = new CEMIFrame({
      code: CEMIMessageCode.L_DATA_REQ,
      data: new CEMILData({
        flags:
          DEFAULT_OUTGOING_FLAGS |
          CEMIFlags.DESTINATION_GROUP_ADDRESS |
          CEMIFlags.PRIORITY_LOW,
        srcAddr: this._assignedAddress ?? new IndividualAddress(0),
        dstAddr: dst,
        tpci: defaultTpci(dst),
        payload: groupValueWrite(value),
      }),
    });
    return this.sendCemi(cemi);
  }

  /** Convenience: GroupValueRead. */
  groupValueRead(destination: GroupAddressInput): Promise<void> {
    const dst = new GroupAddress(destination);
    const cemi = new CEMIFrame({
      code: CEMIMessageCode.L_DATA_REQ,
      data: new CEMILData({
        flags:
          DEFAULT_OUTGOING_FLAGS |
          CEMIFlags.DESTINATION_GROUP_ADDRESS |
          CEMIFlags.PRIORITY_LOW,
        srcAddr: this._assignedAddress ?? new IndividualAddress(0),
        dstAddr: dst,
        tpci: defaultTpci(dst),
        payload: groupValueRead(),
      }),
    });
    return this.sendCemi(cemi);
  }

  // ---------- transport plumbing ----------

  private async _openTransport(): Promise<void> {
    const transport = this._transportFactory(this._opts);
    transport.on('message', (frame, source) => this._onFrame(frame, source));
    transport.on('raw', (_data, _source, err) =>
      this._logger.debug(`Inbound non-KNX-IP datagram dropped: ${err.message}`),
    );
    transport.on('error', (err) => this._logger.warn('Transport error', err));
    const bound = await transport.bind();
    this._transport = transport;

    const useRouteBack = this._opts.routeBack ?? !this._opts.localIp;
    this._localHpai = useRouteBack
      ? HPAI.routeBack()
      : new HPAI(bound.address, bound.port);
  }

  private async _teardownTransport(): Promise<void> {
    const t = this._transport;
    this._transport = null;
    if (!t) return;
    t.removeAllListeners();
    try {
      await t.close();
    } catch (err) {
      this._logger.debug('Transport close error', err);
    }
  }

  // ---------- protocol exchanges ----------

  private async _sendConnectRequest(): Promise<void> {
    if (!this._transport) throw new CommunicationError('No transport');
    const body = new ConnectRequest({
      controlEndpoint: this._localHpai,
      dataEndpoint: this._localHpai,
      cri: new CRI({
        connectionType: ConnectionType.TUNNEL_CONNECTION,
        ...(this._opts.requestedIndividualAddress !== undefined
          ? { individualAddress: this._opts.requestedIndividualAddress }
          : {}),
      }),
    });

    const responsePromise = this._awaitResponse<ConnectResponse>(
      ConnectResponse.SERVICE_TYPE,
      CONNECT_REQUEST_TIMEOUT_MS,
    );
    await this._transport.send(KNXIPFrame.fromBody(body));
    const response = await responsePromise;

    if (response.statusCode !== ErrorCode.E_NO_ERROR) {
      throw new CommunicationError(
        `CONNECT_RESPONSE error: ${errorCodeName(response.statusCode)}`,
      );
    }
    this._channelId = response.communicationChannelId;
    this._assignedAddress = response.crd.individualAddress ?? null;
    this._dataEndpoint = response.dataEndpoint.isRouteBack
      ? null
      : { address: response.dataEndpoint.ip, port: response.dataEndpoint.port };
  }

  private async _sendConnectionStateRequest(): Promise<ConnectionStateResponse> {
    if (!this._transport) throw new CommunicationError('No transport');
    if (this._channelId === null) {
      throw new CommunicationError('No active communication channel');
    }
    const body = new ConnectionStateRequest({
      communicationChannelId: this._channelId,
      controlEndpoint: this._localHpai,
    });
    const responsePromise = this._awaitResponse<ConnectionStateResponse>(
      ConnectionStateResponse.SERVICE_TYPE,
      CONNECTIONSTATE_REQUEST_TIMEOUT_MS,
    );
    await this._transport.send(KNXIPFrame.fromBody(body));
    return responsePromise;
  }

  private async _sendDisconnectRequest(): Promise<void> {
    if (!this._transport || this._channelId === null) return;
    const body = new DisconnectRequest({
      communicationChannelId: this._channelId,
      controlEndpoint: this._localHpai,
    });
    const responsePromise = this._awaitResponse<DisconnectResponse>(
      DisconnectResponse.SERVICE_TYPE,
      CONNECT_REQUEST_TIMEOUT_MS,
    );
    await this._transport.send(KNXIPFrame.fromBody(body));
    try {
      await responsePromise;
    } catch (err) {
      // Tolerate timeout — we're tearing down anyway
      this._logger.debug('No DISCONNECT_RESPONSE before timeout', err);
    }
  }

  private async _tunnellingRequestOnce(rawCemi: Buffer): Promise<void> {
    if (!this._transport || this._channelId === null) {
      throw new CommunicationError('Tunnel not connected');
    }
    const seq = this._seqOut;
    const req = new TunnellingRequest({
      communicationChannelId: this._channelId,
      sequenceCounter: seq,
      rawCemi,
    });
    const ackPromise = this._awaitAck(seq, TUNNELLING_REQUEST_TIMEOUT_MS);
    const target = this._dataEndpoint ?? undefined;
    await this._transport.send(KNXIPFrame.fromBody(req), target);
    await ackPromise;
    this._bumpSeqOut();
  }

  private _bumpSeqOut(): void {
    this._seqOut = (this._seqOut + 1) & 0xff;
  }

  // ---------- inbound dispatch ----------

  private _onFrame(frame: KNXIPFrame, source: SocketAddress): void {
    const body = frame.body;
    // Response-correlated bodies first
    if (this._pendingResponse?.expectedServiceType === frame.header.serviceType) {
      const pr = this._pendingResponse;
      this._pendingResponse = null;
      clearTimeout(pr.timer);
      pr.resolve(body);
      return;
    }

    if (body instanceof TunnellingAck) {
      this._handleAck(body);
      return;
    }
    if (body instanceof TunnellingRequest) {
      this._handleInboundTunnelling(body, source);
      return;
    }
    if (body instanceof DisconnectRequest) {
      this._handleInboundDisconnect(body);
      return;
    }
    // Other body types arriving here means we got a stale response or unexpected
    // frame — log and drop.
    this._logger.debug(`Unhandled body ${body.constructor.name}`);
  }

  private _handleAck(ack: TunnellingAck): void {
    if (!this._pendingAck) {
      this._logger.debug('Stray TUNNELLING_ACK');
      return;
    }
    if (ack.sequenceCounter !== this._pendingAck.sequence) {
      this._logger.warn(
        `TUNNELLING_ACK sequence mismatch: got ${ack.sequenceCounter}, expected ${this._pendingAck.sequence}`,
      );
      return;
    }
    const pa = this._pendingAck;
    this._pendingAck = null;
    clearTimeout(pa.timer);
    if (ack.statusCode !== ErrorCode.E_NO_ERROR) {
      pa.reject(
        new TunnellingAckError(
          `TUNNELLING_ACK error ${errorCodeName(ack.statusCode)}`,
        ),
      );
      return;
    }
    pa.resolve();
  }

  private _handleInboundTunnelling(req: TunnellingRequest, _source: SocketAddress): void {
    if (this._channelId !== null && req.communicationChannelId !== this._channelId) {
      this._logger.warn(
        `TUNNELLING_REQUEST for foreign channel ${req.communicationChannelId} (mine: ${this._channelId})`,
      );
      return;
    }
    const expected = this._seqIn;
    const previous = (expected - 1) & 0xff;

    if (req.sequenceCounter === expected) {
      this._seqIn = (expected + 1) & 0xff;
      this._cancelInvalidSeqTimer();
      this._sendAck(req);
      this._processIncomingCemi(req.rawCemi);
      return;
    }
    if (req.sequenceCounter === previous) {
      // duplicate — ACK but don't re-emit
      this._sendAck(req);
      this._logger.debug(
        `Duplicate TUNNELLING_REQUEST seq=${req.sequenceCounter}; ACK without re-emit`,
      );
      return;
    }
    // truly out of order — per spec drop silently and schedule reconnect after 2x ACK timeout
    this._logger.warn(
      `Out-of-order TUNNELLING_REQUEST seq=${req.sequenceCounter}, expected ${expected}; will reconnect if no recovery`,
    );
    this._armInvalidSeqTimer();
  }

  private _processIncomingCemi(rawCemi: Buffer): void {
    try {
      const { frame } = CEMIFrame.fromKnx(rawCemi);
      this.emit('cemi', frame);
    } catch (err) {
      this._logger.warn(`Could not parse inbound CEMI: ${(err as Error).message}`);
    }
  }

  private _sendAck(req: TunnellingRequest): void {
    if (!this._transport) return;
    const ack = new TunnellingAck({
      communicationChannelId: req.communicationChannelId,
      sequenceCounter: req.sequenceCounter,
    });
    const target = this._dataEndpoint ?? undefined;
    this._transport.send(KNXIPFrame.fromBody(ack), target).catch((err) => {
      this._logger.warn('Failed to send TUNNELLING_ACK', err);
    });
  }

  private _handleInboundDisconnect(req: DisconnectRequest): void {
    // Only acknowledge if the channel matches ours; otherwise the request is
    // for a different tunnel sharing the gateway and we ignore it.
    if (this._transport && this._channelId !== null && req.communicationChannelId === this._channelId) {
      const resp = new DisconnectResponse({ communicationChannelId: this._channelId });
      this._transport.send(KNXIPFrame.fromBody(resp)).catch((err) => {
        this._logger.warn('Failed to send DISCONNECT_RESPONSE', err);
      });
      this._channelId = null;
      this._onTunnelLost(new CommunicationError('Gateway sent DISCONNECT_REQUEST'));
    } else {
      this._logger.debug(
        `Ignored DISCONNECT_REQUEST for foreign channel ${req.communicationChannelId}`,
      );
    }
  }

  // ---------- response/ack correlation ----------

  private _awaitResponse<T>(serviceType: number, timeoutMs: number): Promise<T> {
    if (this._pendingResponse) {
      return Promise.reject(
        new CommunicationError('Another KNX/IP response is already pending'),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingResponse?.timer === timer) {
          this._pendingResponse = null;
        }
        reject(
          new CommunicationError(
            `Timeout waiting for service 0x${serviceType.toString(16)}`,
          ),
        );
      }, timeoutMs);
      this._pendingResponse = {
        expectedServiceType: serviceType,
        resolve: resolve as (b: unknown) => void,
        reject,
        timer,
      };
    });
  }

  private _awaitAck(sequence: number, timeoutMs: number): Promise<void> {
    if (this._pendingAck) {
      return Promise.reject(
        new CommunicationError('A TUNNELLING_ACK is already pending'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingAck?.timer === timer) {
          this._pendingAck = null;
        }
        reject(new TunnellingAckError(`No TUNNELLING_ACK for seq ${sequence} within ${timeoutMs}ms`));
      }, timeoutMs);
      this._pendingAck = { sequence, resolve, reject, timer };
    });
  }

  private _rejectPendingAck(err: Error): void {
    if (!this._pendingAck) return;
    const pa = this._pendingAck;
    this._pendingAck = null;
    clearTimeout(pa.timer);
    pa.reject(err);
  }

  private _rejectPendingResponse(err: Error): void {
    if (!this._pendingResponse) return;
    const pr = this._pendingResponse;
    this._pendingResponse = null;
    clearTimeout(pr.timer);
    pr.reject(err);
  }

  // ---------- heartbeat ----------

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    if (this._opts.heartbeatIntervalMs <= 0) return; // disabled
    const timer = setInterval(() => this._heartbeat(), this._opts.heartbeatIntervalMs);
    // .unref() — the heartbeat alone should never keep the Node event loop alive;
    // the user disposes of the tunnel via disconnect() when they want it gone.
    timer.unref?.();
    this._heartbeatTimer = timer;
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private async _heartbeat(): Promise<void> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < HEARTBEAT_MAX_FAILURES; attempt++) {
      try {
        const resp = await this._sendConnectionStateRequest();
        if (resp.statusCode === ErrorCode.E_NO_ERROR) return;
        lastErr = new CommunicationError(
          `Heartbeat status ${errorCodeName(resp.statusCode)}`,
        );
      } catch (err) {
        lastErr = err as Error;
      }
    }
    this._onTunnelLost(
      new CommunicationError(`Heartbeat failed: ${lastErr?.message ?? 'unknown'}`),
    );
  }

  // ---------- invalid-sequence inbound timer ----------

  private _armInvalidSeqTimer(): void {
    if (this._invalidSeqTimer || this._reconnectPromise) return;
    this._invalidSeqTimer = setTimeout(() => {
      this._invalidSeqTimer = null;
      this._onTunnelLost(
        new CommunicationError(
          'Out-of-order TUNNELLING_REQUEST not recovered within 2s',
        ),
      );
    }, 2 * TUNNELLING_REQUEST_TIMEOUT_MS);
  }

  private _cancelInvalidSeqTimer(): void {
    if (this._invalidSeqTimer) {
      clearTimeout(this._invalidSeqTimer);
      this._invalidSeqTimer = null;
    }
  }

  // ---------- tunnel-lost / reconnect ----------

  private _onTunnelLost(reason: Error): void {
    if (this._state === 'disconnected' || this._state === 'disconnecting') return;
    this._logger.warn(`Tunnel lost: ${reason.message}`);
    this.emit('warning', reason);

    this._stopHeartbeat();
    this._cancelInvalidSeqTimer();
    this._rejectPendingAck(reason);
    this._rejectPendingResponse(reason);

    // Capture the transport before nulling so async close runs without races.
    const transport = this._transport;
    this._transport = null;
    if (transport) {
      transport.removeAllListeners();
      transport.close().catch(() => undefined);
    }
    this._channelId = null;
    this._dataEndpoint = null;
    this._setState('disconnected');

    if (!this._opts.autoReconnect || this._reconnectAbort) {
      this.emit('error', reason);
      return;
    }
    if (this._reconnectPromise) return;

    this._reconnectPromise = (async () => {
      let attempt = 1;
      while (!this._reconnectAbort) {
        try {
          this._logger.debug(`Reconnect attempt ${attempt}`);
          await this.connect();
          return;
        } catch (err) {
          this._logger.debug(
            `Reconnect attempt ${attempt} failed: ${(err as Error).message}`,
          );
          attempt += 1;
          await delayUnref(this._opts.autoReconnectWaitMs);
        }
      }
    })();
    // Detach so unhandled rejection isn't possible — caller awaits via getter only when meaningful
    this._reconnectPromise.catch(() => undefined).finally(() => {
      this._reconnectPromise = null;
    });
  }

  // ---------- state ----------

  private _setState(next: TunnelState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this.emit('state', next, prev);
  }
}

function delayUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function defaultTransportFactory(opts: TunnelClientOptions): UdpTransport {
  return new UdpTransport({
    remoteAddress: opts.gatewayIp,
    remotePort: opts.gatewayPort ?? KNX_PORT,
    ...(opts.localIp !== undefined ? { localAddress: opts.localIp } : {}),
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
  });
}

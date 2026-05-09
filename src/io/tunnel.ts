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
import { ConnectionType, ErrorCode, HostProtocol, errorCodeName } from '../core/serviceTypes';
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
import { SecureSession } from './secureSession';
import { SerialQueue } from './serialQueue';
import { TcpTransport } from './tcpTransport';
import type { Transport } from './transport';
import { type SocketAddress, UdpTransport } from './udpTransport';

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

/**
 * Snapshot returned by `TunnelClient.getDiagnostics()`. Suitable for serving
 * directly from an admin endpoint or feeding into a monitoring sidebar.
 *
 * All `*Ts` fields are wall-clock milliseconds since epoch; `null` means the
 * event has never been observed for this tunnel. Counters reset only on
 * client construction — they accumulate across reconnects.
 */
export interface TunnelDiagnostics {
  state: TunnelState;
  assignedAddress: string | null;
  gatewayIp: string;
  gatewayPort: number;
  transport: 'udp' | 'tcp';
  secure: boolean;
  sendQueueDepth: number;
  txTelegrams: number;
  rxTelegrams: number;
  heartbeatsOk: number;
  heartbeatsFailed: number;
  reconnects: number;
  lastFrameTs: number | null;
  lastTxTs: number | null;
  lastRxTs: number | null;
  lastHeartbeatOkTs: number | null;
  lastHeartbeatFailTs: number | null;
  lastReconnectTs: number | null;
  lastTunnelLostReason: string | null;
  connectedAtTs: number | null;
  /** Milliseconds since the current connect; 0 if not connected. */
  uptimeMs: number;
  /** Milliseconds since the last frame in either direction; null if never. */
  sinceLastFrameMs: number | null;
}

export interface SecureTunnelOptions {
  /** Tunnelling user ID (1..127). User 1 is "management" — usually a regular
   *  user (2..127) is what you configure for runtime traffic. */
  userId: number;
  /**
   * Plaintext device authentication password. Optional: omit for
   * single-password / non-ETS devices that don't expose a Device Auth Code.
   * When absent the SESSION_RESPONSE MAC is not verified (see
   * SecureSessionOptions.deviceAuthPassword for the trade-off).
   */
  deviceAuthPassword?: string;
  /** Plaintext user password. */
  userPassword: string;
  /** Optional uint48 sender serial number. Default uses a fixed identifier. */
  serialNumber?: number;
  /** Optional uint16 message tag. Default 0. */
  messageTag?: number;
}

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
  /**
   * Transport mode. Defaults to `'udp'`. KNX/IP Secure tunneling requires
   * TCP per spec, so `secure: {...}` will force TCP regardless of this value.
   */
  transport?: 'udp' | 'tcp';
  /**
   * KNX/IP Secure credentials. When set, the tunnel runs over TCP and every
   * frame is wrapped in a SECURE_WRAPPER body. When omitted, classic UDP
   * tunneling is used.
   */
  secure?: SecureTunnelOptions;
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
  private _transport: Transport | null = null;
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

  // Counters surfaced via getDiagnostics(). All wall-clock timestamps are
  // ms-since-epoch; null means "never observed yet". Counters reset on
  // construction; they do *not* reset on reconnect so cumulative behaviour
  // over a tunnel's whole lifetime stays visible.
  private readonly _stats = {
    txTelegrams: 0,
    rxTelegrams: 0,
    heartbeatsOk: 0,
    heartbeatsFailed: 0,
    reconnects: 0,
    lastFrameTs: null as number | null,
    lastTxTs: null as number | null,
    lastRxTs: null as number | null,
    lastHeartbeatOkTs: null as number | null,
    lastHeartbeatFailTs: null as number | null,
    lastReconnectTs: null as number | null,
    lastTunnelLostReason: null as string | null,
    connectedAtTs: null as number | null,
  };

  /** Tunnel-builder transport factory (overridable for tests). */
  private readonly _transportFactory: (opts: TunnelClientOptions) => Transport;

  constructor(
    opts: TunnelClientOptions,
    transportFactory: (opts: TunnelClientOptions) => Transport = defaultTransportFactory,
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

  /**
   * Snapshot of the tunnel's runtime counters and last-seen timestamps.
   * Pure getter — cheap to call from a polling admin endpoint or a UI tick.
   */
  getDiagnostics(): TunnelDiagnostics {
    const now = Date.now();
    return {
      state: this._state,
      assignedAddress: this._assignedAddress?.toString() ?? null,
      gatewayIp: this._opts.gatewayIp,
      gatewayPort: this._opts.gatewayPort,
      transport: this._isOverTcp() ? 'tcp' : 'udp',
      secure: this._opts.secure !== undefined,
      sendQueueDepth: this._sendQueue.depth,
      txTelegrams: this._stats.txTelegrams,
      rxTelegrams: this._stats.rxTelegrams,
      heartbeatsOk: this._stats.heartbeatsOk,
      heartbeatsFailed: this._stats.heartbeatsFailed,
      reconnects: this._stats.reconnects,
      lastFrameTs: this._stats.lastFrameTs,
      lastTxTs: this._stats.lastTxTs,
      lastRxTs: this._stats.lastRxTs,
      lastHeartbeatOkTs: this._stats.lastHeartbeatOkTs,
      lastHeartbeatFailTs: this._stats.lastHeartbeatFailTs,
      lastReconnectTs: this._stats.lastReconnectTs,
      lastTunnelLostReason: this._stats.lastTunnelLostReason,
      connectedAtTs: this._stats.connectedAtTs,
      uptimeMs:
        this._state === 'connected' && this._stats.connectedAtTs
          ? now - this._stats.connectedAtTs
          : 0,
      sinceLastFrameMs:
        this._stats.lastFrameTs !== null ? now - this._stats.lastFrameTs : null,
    };
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
    this._stats.connectedAtTs = Date.now();
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
    // Pick the HPAI host-protocol byte to match the transport. Secure runs
    // exclusively over TCP; classic tunneling can run on either, but the
    // gateway expects the HPAI's protocol byte to match the actual socket
    // type or it silently drops the frame.
    const hpaiProto =
      this._opts.secure !== undefined || this._opts.transport === 'tcp'
        ? HostProtocol.IPV4_TCP
        : HostProtocol.IPV4_UDP;
    this._localHpai = useRouteBack
      ? HPAI.routeBack(hpaiProto)
      : new HPAI(bound.address, bound.port, hpaiProto);
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
    // Many gateways — especially Secure ones — handle disconnect by simply
    // closing the TCP socket without sending a DISCONNECT_RESPONSE. Race the
    // response against the transport closing so a clean teardown doesn't
    // hold the disconnect path for the full 10 s timeout. Use a tighter
    // ceiling (3 s) on TCP since the gateway should react promptly.
    const tcp = this._isOverTcp();
    const timeoutMs = tcp ? 3_000 : CONNECT_REQUEST_TIMEOUT_MS;
    const responsePromise = this._awaitResponse<DisconnectResponse>(
      DisconnectResponse.SERVICE_TYPE,
      timeoutMs,
    );
    const closePromise = new Promise<void>((resolve) => {
      const t = this._transport;
      if (!t) return resolve();
      const onClose = () => {
        t.off('close', onClose);
        resolve();
      };
      t.once('close', onClose);
    });
    await this._transport.send(KNXIPFrame.fromBody(body));
    try {
      await Promise.race([responsePromise, closePromise]);
    } catch (err) {
      // Tolerate timeout — we're tearing down anyway
      this._logger.debug('No DISCONNECT_RESPONSE before timeout', err);
    }
  }

  private async _tunnellingRequestOnce(rawCemi: Buffer): Promise<void> {
    if (!this._transport || this._channelId === null) {
      throw new CommunicationError('Tunnel not connected');
    }
    // Over TCP, send seq=0 always (spec §4.4). Over UDP, use the rolling
    // 8-bit sequence counter.
    const seq = this._isOverTcp() ? 0 : this._seqOut;
    const req = new TunnellingRequest({
      communicationChannelId: this._channelId,
      sequenceCounter: seq,
      rawCemi,
    });
    const ackPromise = this._awaitAck(seq, TUNNELLING_REQUEST_TIMEOUT_MS);
    const target = this._dataEndpoint ?? undefined;
    await this._transport.send(KNXIPFrame.fromBody(req), target);
    await ackPromise;
    const now = Date.now();
    this._stats.txTelegrams += 1;
    this._stats.lastTxTs = now;
    this._stats.lastFrameTs = now;
    if (!this._isOverTcp()) this._bumpSeqOut();
  }

  private _bumpSeqOut(): void {
    this._seqOut = (this._seqOut + 1) & 0xff;
  }

  /** True when the tunnel runs over TCP (Secure or plain TCP profile). */
  private _isOverTcp(): boolean {
    return this._opts.secure !== undefined || this._opts.transport === 'tcp';
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
    // KNX/IP Secure §4.4 (and the plain-TCP tunneling profile): over TCP the
    // inner tunnelling sequence counter is fixed at 0 and the receiver MUST
    // NOT enforce monotonic ordering — TCP already guarantees in-order
    // delivery. Skipping the seq-equals-expected check here is what makes
    // every telegram after the first NOT get treated as a duplicate.
    if (this._isOverTcp()) {
      this._logger.debug(
        `inbound TUNNELLING_REQUEST seq=${req.sequenceCounter} (TCP — seq ignored)`,
      );
      this._sendAck(req);
      this._processIncomingCemi(req.rawCemi);
      return;
    }

    const expected = this._seqIn;
    const previous = (expected - 1) & 0xff;
    this._logger.debug(
      `inbound TUNNELLING_REQUEST seq=${req.sequenceCounter} (expected ${expected}, prev ${previous})`,
    );

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
      const now = Date.now();
      this._stats.rxTelegrams += 1;
      this._stats.lastRxTs = now;
      this._stats.lastFrameTs = now;
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
        if (resp.statusCode === ErrorCode.E_NO_ERROR) {
          this._stats.heartbeatsOk += 1;
          this._stats.lastHeartbeatOkTs = Date.now();
          return;
        }
        lastErr = new CommunicationError(
          `Heartbeat status ${errorCodeName(resp.statusCode)}`,
        );
      } catch (err) {
        lastErr = err as Error;
      }
    }
    this._stats.heartbeatsFailed += 1;
    this._stats.lastHeartbeatFailTs = Date.now();
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
    this._stats.reconnects += 1;
    this._stats.lastReconnectTs = Date.now();
    this._stats.lastTunnelLostReason = reason.message;
    this._stats.connectedAtTs = null;
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

function defaultTransportFactory(opts: TunnelClientOptions): Transport {
  // KNX/IP Secure tunneling is TCP-only per spec. If the caller supplied
  // secure credentials, force TCP and wrap the transport in a SecureSession.
  const useTcp = opts.secure !== undefined || opts.transport === 'tcp';

  if (!useTcp) {
    return new UdpTransport({
      remoteAddress: opts.gatewayIp,
      remotePort: opts.gatewayPort ?? KNX_PORT,
      ...(opts.localIp !== undefined ? { localAddress: opts.localIp } : {}),
      ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
    });
  }

  const tcp = new TcpTransport({
    remoteAddress: opts.gatewayIp,
    remotePort: opts.gatewayPort ?? KNX_PORT,
  });

  if (!opts.secure) {
    return tcp;
  }

  return new SecureSession(tcp, {
    userId: opts.secure.userId,
    userPassword: opts.secure.userPassword,
    ...(opts.secure.deviceAuthPassword
      ? { deviceAuthPassword: opts.secure.deviceAuthPassword }
      : {}),
    ...(opts.secure.serialNumber !== undefined
      ? { serialNumber: BigInt(opts.secure.serialNumber) }
      : {}),
    ...(opts.secure.messageTag !== undefined ? { messageTag: opts.secure.messageTag } : {}),
    logger: {
      debug: (msg) => opts.logger?.debug?.(`[secure] ${msg}`),
      info: (msg) => opts.logger?.info?.(`[secure] ${msg}`),
      warn: (msg) => opts.logger?.warn?.(`[secure] ${msg}`),
      error: (msg) => opts.logger?.error?.(`[secure] ${msg}`),
    },
  });
}

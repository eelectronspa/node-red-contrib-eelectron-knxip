// KNX/IP Secure session driver.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Sits between an inner transport (UDP for routing, TCP for tunneling) and
// the higher-level tunnel/routing logic. Outgoing frames are wrapped in a
// SECURE_WRAPPER body; incoming SECURE_WRAPPER bodies are unwrapped and
// re-emitted as plain KNXIPFrame objects on the `message` event.
//
// Lifecycle / state machine:
//   IDLE → REQUESTING (sent SESSION_REQUEST)
//        → AUTHENTICATING (got SESSION_RESPONSE, sent SESSION_AUTHENTICATE)
//        → AUTHENTICATED (got SESSION_STATUS == 0)
//        → CLOSING / CLOSED
//
// Failure paths emit an 'error' event and transition to CLOSED.

import { EventEmitter } from 'node:events';
import {
  SecureWrapper,
  SessionAuthenticate,
  SessionRequest,
  SessionResponse,
  SessionStatus,
  type SecureSessionStatus,
  secureSessionStatusName,
} from '../core/bodies';
import { KNXIPFrame } from '../core/knxipFrame';
import {
  generateX25519KeyPair,
  x25519SharedSecret,
} from '../secure/crypto';
import { computeAuthenticateMac, computeSessionResponseMac } from '../secure/handshake';
import {
  deriveDeviceAuthCode,
  deriveSessionKey,
  deriveUserPasswordKey,
} from '../secure/keys';
import { decryptSecureWrapper, encryptSecureWrapper } from '../secure/wrapper';
import type { SocketAddress } from './udpTransport';

/** Subset of transport surface SecureSession needs. Lets it sit on top of UDP or TCP. */
export interface InnerTransport extends EventEmitter {
  bind(): Promise<SocketAddress>;
  send(frame: KNXIPFrame, addr?: SocketAddress): Promise<void>;
  close(): Promise<void>;
}

export type SecureSessionState =
  | 'idle'
  | 'requesting'
  | 'authenticating'
  | 'authenticated'
  | 'closing'
  | 'closed';

export interface SecureSessionOptions {
  /** Tunnelling user id (1..127). */
  userId: number;
  /**
   * Plaintext device-authentication password.
   *
   * Optional: omit (or pass an empty string) for non-ETS / single-password
   * devices that don't expose a Device Authentication Code in their UI. When
   * absent, the SESSION_RESPONSE MAC check is skipped — we still authenticate
   * the client to the server with userId + userPassword, but we cannot
   * cryptographically verify the server's identity (no MITM protection on the
   * device-auth side). The KNX/IP Secure handshake otherwise proceeds
   * normally.
   */
  deviceAuthPassword?: string;
  /** Plaintext user password. */
  userPassword: string;
  /**
   * 6-byte sender serial number used in the SECURE_WRAPPER block_0/counter_0.
   * Defaults to a deterministic value derived from a constant we use as our
   * "vendor id". Real devices use their MAC-based serial; for client-side
   * tunnelling any unique-ish value works.
   */
  serialNumber?: bigint;
  /** uint16 message tag. KNX uses 0x0000 for tunnelling. */
  messageTag?: number;
  /** Timeout (ms) for the handshake to complete. Default 10 000. */
  handshakeTimeoutMs?: number;
  /** Period (ms) for SESSION_STATUS keepalive after authentication. Default 30 000. */
  keepaliveMs?: number;
  /** Optional logger. */
  logger?: {
    debug?: (msg: string) => void;
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

const DEFAULT_SERIAL: bigint = 0xeeec_0001_0001n;

interface PendingPromise<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * SecureSession orchestrates the four-message KNX/IP Secure handshake against
 * an already-bound transport, then transparently wraps every send/receive in
 * SECURE_WRAPPER.
 */
export class SecureSession extends EventEmitter {
  private readonly inner: InnerTransport;
  private readonly opts: Required<
    Pick<SecureSessionOptions, 'userId' | 'serialNumber' | 'messageTag' | 'handshakeTimeoutMs' | 'keepaliveMs'>
  > & { logger: NonNullable<SecureSessionOptions['logger']> };

  private readonly clientPriv: Buffer;
  private readonly clientPub: Buffer;
  /** null when no device-auth password was provided — MAC check is skipped. */
  private readonly deviceAuthCode: Buffer | null;
  private readonly userPasswordKey: Buffer;

  private _state: SecureSessionState = 'idle';
  private _sessionId = 0;
  private _serverPub: Buffer | null = null;
  private _sessionKey: Buffer | null = null;
  private _sequenceId = 0;
  private _keepaliveTimer: NodeJS.Timeout | null = null;
  private _pendingHandshake: PendingPromise<void> | null = null;

  constructor(inner: InnerTransport, opts: SecureSessionOptions) {
    super();
    this.inner = inner;
    this.opts = {
      userId: opts.userId,
      serialNumber: opts.serialNumber ?? DEFAULT_SERIAL,
      messageTag: opts.messageTag ?? 0,
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 10_000,
      keepaliveMs: opts.keepaliveMs ?? 30_000,
      logger: opts.logger ?? {},
    };

    const kp = generateX25519KeyPair();
    this.clientPriv = kp.privateKey;
    this.clientPub = kp.publicKey;
    this.deviceAuthCode = opts.deviceAuthPassword
      ? deriveDeviceAuthCode(opts.deviceAuthPassword)
      : null;
    this.userPasswordKey = deriveUserPasswordKey(opts.userPassword);

    this.inner.on('message', this._onInnerFrame);
    this.inner.on('error', this._onInnerError);
    this.inner.on('close', this._onInnerClose);
  }

  /**
   * Drop-in replacement for `UdpTransport.bind()` — binds the inner transport
   * and walks the handshake. Resolves with the inner transport's local
   * address, so callers that already work against a `UdpTransport` interface
   * don't need to know there's a secure session in the way.
   */
  async bind(): Promise<SocketAddress> {
    const addr = await this.inner.bind();
    await this.open();
    return addr;
  }

  get state(): SecureSessionState {
    return this._state;
  }
  get sessionId(): number {
    return this._sessionId;
  }
  get sessionKey(): Buffer | null {
    return this._sessionKey;
  }

  /**
   * Run the full handshake. Resolves once SESSION_STATUS confirms
   * authentication; rejects on protocol errors or timeout.
   *
   * Caller is expected to have already called `inner.bind()`.
   */
  async open(): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`SecureSession.open() called in state ${this._state}`);
    }
    return new Promise<void>((resolve, reject) => {
      // Note: do NOT unref this timer. Production code wraps SecureSession in
      // a TunnelClient that always has a transport socket keeping the event
      // loop alive, and `node:test` treats unrefed timers as "no work
      // pending" and cancels awaits before the timeout fires.
      const timer = setTimeout(() => {
        this._failHandshake(new Error('SecureSession handshake timeout'));
      }, this.opts.handshakeTimeoutMs);
      this._pendingHandshake = { resolve, reject, timer };

      this._setState('requesting');
      const req = new SessionRequest({ publicKey: Buffer.from(this.clientPub) });
      this.inner
        .send(KNXIPFrame.fromBody(req))
        .catch((err) => this._failHandshake(err as Error));
    });
  }

  /** Wrap and transmit a plaintext KNX/IP frame. */
  async send(frame: KNXIPFrame): Promise<void> {
    if (this._state !== 'authenticated') {
      throw new Error(`SecureSession.send() while ${this._state}`);
    }
    if (!this._sessionKey) throw new Error('SecureSession has no session key');
    const seq = this._sequenceId;
    this._sequenceId += 1;
    if (this._sequenceId > 0xffff_ffff_ffff) {
      throw new Error(
        'SecureSession sequence counter exhausted — restart the session',
      );
    }
    const plainBuf = frame.toKnx();
    const { encryptedFrame, mac } = encryptSecureWrapper({
      sessionKey: this._sessionKey,
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      plainFrame: plainBuf,
    });
    const wrapper = new SecureWrapper({
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      encryptedFrame,
      mac,
    });
    return this.inner.send(KNXIPFrame.fromBody(wrapper));
  }

  /** Send a SESSION_STATUS=close, then tear down. Idempotent. */
  async close(): Promise<void> {
    if (this._state === 'closed' || this._state === 'closing') {
      try {
        await this.inner.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this._setState('closing');
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    try {
      // Best-effort SESSION_STATUS=CLOSE so the gateway frees the session.
      if (this._sessionKey) {
        await this._sendStatus(0x05); // CLOSE
      }
    } catch {
      /* swallow — we're closing */
    }
    try {
      await this.inner.close();
    } finally {
      this._setState('closed');
    }
  }

  // -------- internals --------

  private _setState(next: SecureSessionState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this.emit('state', next, prev);
  }

  private _failHandshake(err: Error): void {
    if (this._pendingHandshake) {
      clearTimeout(this._pendingHandshake.timer);
      this._pendingHandshake.reject(err);
      this._pendingHandshake = null;
    }
    this._setState('closed');
    this.emit('error', err);
  }

  private _completeHandshake(): void {
    if (this._pendingHandshake) {
      clearTimeout(this._pendingHandshake.timer);
      this._pendingHandshake.resolve();
      this._pendingHandshake = null;
    }
    this._setState('authenticated');
    if (this.opts.keepaliveMs > 0) {
      this._keepaliveTimer = setInterval(() => {
        this._sendStatus(0x04).catch((err) =>
          this.opts.logger.warn?.(`SESSION_STATUS keepalive failed: ${(err as Error).message}`),
        );
      }, this.opts.keepaliveMs);
      this._keepaliveTimer.unref?.();
    }
  }

  private async _sendStatus(code: SecureSessionStatus | number): Promise<void> {
    if (!this._sessionKey) return;
    const inner = KNXIPFrame.fromBody(new SessionStatus({ status: code }));
    const seq = this._sequenceId;
    this._sequenceId += 1;
    const { encryptedFrame, mac } = encryptSecureWrapper({
      sessionKey: this._sessionKey,
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      plainFrame: inner.toKnx(),
    });
    const wrapper = new SecureWrapper({
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      encryptedFrame,
      mac,
    });
    await this.inner.send(KNXIPFrame.fromBody(wrapper));
  }

  private readonly _onInnerFrame = (frame: KNXIPFrame, source: SocketAddress) => {
    try {
      this._handleInnerFrame(frame, source);
    } catch (err) {
      this._failHandshake(err as Error);
    }
  };

  private _handleInnerFrame(frame: KNXIPFrame, source: SocketAddress): void {
    if (frame.body instanceof SessionResponse) {
      this._onSessionResponse(frame.body);
      return;
    }
    if (frame.body instanceof SecureWrapper) {
      this._onSecureWrapper(frame.body, source);
      return;
    }
    if (frame.body instanceof SessionStatus) {
      this._onPlainSessionStatus(frame.body);
      return;
    }
    // Anything else (e.g. plain TUNNELLING_REQUEST during handshake — shouldn't
    // happen) gets surfaced raw so the caller can decide.
    this.opts.logger.debug?.(`SecureSession: unexpected inner frame type`);
    this.emit('plainMessage', frame, source);
  }

  private _onSessionResponse(body: SessionResponse): void {
    if (this._state !== 'requesting') {
      this.opts.logger.warn?.(`Stray SESSION_RESPONSE while ${this._state}`);
      return;
    }
    this._sessionId = body.sessionId;
    this._serverPub = Buffer.from(body.publicKey);

    // Verify SESSION_RESPONSE MAC — only when a device-auth password was
    // provided. Single-password / non-ETS devices don't expose a DAC in their
    // UI, so the user can't supply one; in that case we skip server-identity
    // verification and rely solely on SESSION_AUTHENTICATE (client→server) for
    // authentication. The session is still encrypted; only the anti-MITM
    // guarantee on the server side is forgone.
    if (this.deviceAuthCode) {
      const expectedMac = computeSessionResponseMac({
        deviceAuthCode: this.deviceAuthCode,
        sessionId: this._sessionId,
        clientPublicKey: this.clientPub,
        serverPublicKey: this._serverPub,
      });
      if (!expectedMac.equals(body.mac)) {
        this._failHandshake(new Error('SESSION_RESPONSE MAC verification failed (wrong device auth password?)'));
        return;
      }
    } else {
      this.opts.logger.warn?.(
        'SESSION_RESPONSE MAC not verified — no device-auth password configured',
      );
    }

    // Derive shared session key.
    const shared = x25519SharedSecret(this.clientPriv, this._serverPub);
    this._sessionKey = deriveSessionKey(shared);

    // Build SESSION_AUTHENTICATE.
    const authMac = computeAuthenticateMac({
      userPasswordKey: this.userPasswordKey,
      userId: this.opts.userId,
      clientPublicKey: this.clientPub,
      serverPublicKey: this._serverPub,
    });
    const authBody = new SessionAuthenticate({ userId: this.opts.userId, mac: authMac });
    this._setState('authenticating');
    // Per KNX/IP Secure §2.5.6, SESSION_AUTHENTICATE is computed over the
    // unwrapped header bytes (which is what `computeAuthenticateMac` did
    // above), but the resulting frame must be transmitted inside a
    // SECURE_WRAPPER using the freshly-negotiated session key. Sending it
    // plain causes most gateways to silently drop it and reply with
    // SESSION_STATUS=TIMEOUT after the handshake window expires.
    const innerFrame = KNXIPFrame.fromBody(authBody).toKnx();
    const seq = this._sequenceId;
    this._sequenceId += 1;
    const { encryptedFrame, mac: wrapperMac } = encryptSecureWrapper({
      sessionKey: this._sessionKey,
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      plainFrame: innerFrame,
    });
    const wrapped = new SecureWrapper({
      sessionId: this._sessionId,
      sequenceId: seq,
      serialNumber: Number(this.opts.serialNumber),
      messageTag: this.opts.messageTag,
      encryptedFrame,
      mac: wrapperMac,
    });
    this.inner
      .send(KNXIPFrame.fromBody(wrapped))
      .catch((err) => this._failHandshake(err as Error));
  }

  /** Plain (unwrapped) SESSION_STATUS only ever appears during the handshake. */
  private _onPlainSessionStatus(body: SessionStatus): void {
    if (this._state !== 'authenticating') {
      this.opts.logger.warn?.(`Plain SESSION_STATUS=${body.status} while ${this._state}`);
      return;
    }
    if (body.status === 0x00 /* AUTHENTICATION_SUCCESS */) {
      this._completeHandshake();
    } else {
      this._failHandshake(
        new Error(`SESSION_STATUS ${secureSessionStatusName(body.status)} — authentication rejected`),
      );
    }
  }

  private _onSecureWrapper(body: SecureWrapper, source: SocketAddress): void {
    if (!this._sessionKey) {
      this.opts.logger.warn?.('Received SECURE_WRAPPER before session key established');
      return;
    }
    if (body.sessionId !== this._sessionId) {
      this.opts.logger.warn?.(
        `Received SECURE_WRAPPER for foreign session ${body.sessionId} (ours: ${this._sessionId})`,
      );
      return;
    }
    let plain: Buffer;
    try {
      plain = decryptSecureWrapper({
        sessionKey: this._sessionKey,
        sessionId: this._sessionId,
        sequenceId: body.sequenceId,
        serialNumber: body.serialNumber,
        messageTag: body.messageTag,
        encryptedFrame: body.encryptedFrame,
        mac: body.mac,
      });
    } catch (err) {
      this.opts.logger.warn?.(
        `SECURE_WRAPPER decrypt failed (seq=${body.sequenceId}): ${(err as Error).message}`,
      );
      return;
    }

    let inner: KNXIPFrame;
    try {
      inner = KNXIPFrame.fromKnx(plain).frame;
    } catch (err) {
      this.opts.logger.warn?.(
        `SECURE_WRAPPER inner frame did not parse: ${(err as Error).message}`,
      );
      return;
    }

    // Hidden-from-user plumbing — keepalive ACK / status messages.
    if (inner.body instanceof SessionStatus) {
      const code = inner.body.status;
      this.opts.logger.debug?.(`SECURE inner SESSION_STATUS = ${secureSessionStatusName(code)}`);
      // Some gateways deliver the auth-result SESSION_STATUS as a SECURE_WRAPPER
      // (using the freshly-negotiated session key) rather than a plain frame.
      // Treat it as the handshake outcome when we're still authenticating.
      if (this._state === 'authenticating') {
        if (code === 0x00 /* AUTHENTICATION_SUCCESS */) {
          this._completeHandshake();
        } else {
          this._failHandshake(
            new Error(
              `SESSION_STATUS ${secureSessionStatusName(code)} — authentication rejected (check user ID and that the user's password has been programmed into the gateway from ETS)`,
            ),
          );
        }
        return;
      }
      if (code === 0x05 /* CLOSE */) {
        this.emit('error', new Error('Gateway closed the secure session'));
        void this.close();
      }
      return;
    }

    this.emit('message', inner, source);
  }

  private readonly _onInnerError = (err: Error) => {
    if (this._pendingHandshake) {
      this._failHandshake(err);
    } else {
      this.emit('error', err);
    }
  };

  private readonly _onInnerClose = () => {
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = null;
    this._setState('closed');
    this.emit('close');
  };
}

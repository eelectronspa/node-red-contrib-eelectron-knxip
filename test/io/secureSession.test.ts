import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  SecureWrapper,
  SessionAuthenticate,
  SessionRequest,
  SessionResponse,
  SessionStatus,
  TunnellingRequest,
} from '../../src/core/bodies';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ServiceType } from '../../src/core/serviceTypes';
import { SecureSession } from '../../src/io/secureSession';
import {
  generateX25519KeyPair,
  x25519SharedSecret,
} from '../../src/secure/crypto';
import {
  computeAuthenticateMac,
  computeSessionResponseMac,
} from '../../src/secure/handshake';
import {
  deriveDeviceAuthCode,
  deriveSessionKey,
  deriveUserPasswordKey,
} from '../../src/secure/keys';
import { decryptSecureWrapper, encryptSecureWrapper } from '../../src/secure/wrapper';
// (encryptSecureWrapper used in the second describe block to synthesise a
// server-side wrapped frame for the client to decrypt.)
import type { SocketAddress } from '../../src/io/udpTransport';

/**
 * MockTransport is a paired bidirectional pipe — each side gets a "send"
 * method that delivers to the other side's `'message'` listener after a
 * microtask. Lets us run a SecureSession against an in-process server.
 */
class MockTransport extends EventEmitter {
  bound = false;
  closed = false;
  peer: MockTransport | null = null;
  bind(): Promise<SocketAddress> {
    this.bound = true;
    return Promise.resolve({ address: '127.0.0.1', port: 50000 });
  }
  send(frame: KNXIPFrame, _addr?: SocketAddress): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.peer && !this.peer.closed) {
      // Re-parse to simulate a wire round-trip — paranoid but cheap.
      const buf = frame.toKnx();
      const parsed = KNXIPFrame.fromKnx(buf).frame;
      // setImmediate (not queueMicrotask) so node:test's event-loop tracker
      // sees the pending work and doesn't cancel awaits prematurely.
      setImmediate(() =>
        this.peer!.emit('message', parsed, { address: '127.0.0.1', port: 0 }),
      );
    }
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    setImmediate(() => this.emit('close'));
    return Promise.resolve();
  }
}

interface FakeServerOpts {
  deviceAuthPassword: string;
  userPassword: string;
  expectedUserId: number;
  /** When true, emits a SESSION_STATUS=AUTHENTICATION_FAILED instead of success. */
  rejectAuth?: boolean;
}

/**
 * Plays the gateway side of the secure handshake against a MockTransport.
 * Just enough logic to drive a SecureSession through to authenticated and
 * accept one wrapped frame.
 */
class FakeServer {
  readonly transport = new MockTransport();
  private serverPriv: Buffer;
  serverPub: Buffer;
  private deviceAuthCode: Buffer;
  private userPasswordKey: Buffer;
  sessionKey: Buffer | null = null;
  sessionId = 0x0042;
  receivedFromClient: KNXIPFrame[] = [];
  private clientPub: Buffer | null = null;

  constructor(private readonly opts: FakeServerOpts) {
    const kp = generateX25519KeyPair();
    this.serverPriv = kp.privateKey;
    this.serverPub = kp.publicKey;
    this.deviceAuthCode = deriveDeviceAuthCode(opts.deviceAuthPassword);
    this.userPasswordKey = deriveUserPasswordKey(opts.userPassword);

    this.transport.on('message', (frame: KNXIPFrame) => this.onFrame(frame));
  }

  private onFrame(frame: KNXIPFrame): void {
    if (frame.body instanceof SessionRequest) {
      this.clientPub = Buffer.from(frame.body.publicKey);
      const mac = computeSessionResponseMac({
        deviceAuthCode: this.deviceAuthCode,
        sessionId: this.sessionId,
        clientPublicKey: this.clientPub,
        serverPublicKey: this.serverPub,
      });
      const response = new SessionResponse({
        sessionId: this.sessionId,
        publicKey: Buffer.from(this.serverPub),
        mac,
      });
      this.transport.send(KNXIPFrame.fromBody(response));
      // Derive our session key for later validation.
      const shared = x25519SharedSecret(this.serverPriv, this.clientPub);
      this.sessionKey = deriveSessionKey(shared);
      return;
    }

    if (frame.body instanceof SecureWrapper) {
      // Real gateways receive SESSION_AUTHENTICATE wrapped in SECURE_WRAPPER
      // (using the freshly-negotiated session key) per KNX/IP Secure §2.5.6,
      // and reply to it with SESSION_STATUS *also* wrapped. This mock mirrors
      // that behaviour so the test exercises the same code path the live
      // protocol does.
      if (!this.sessionKey) return;
      const plain = decryptSecureWrapper({
        sessionKey: this.sessionKey,
        sessionId: frame.body.sessionId,
        sequenceId: frame.body.sequenceId,
        serialNumber: frame.body.serialNumber,
        messageTag: frame.body.messageTag,
        encryptedFrame: frame.body.encryptedFrame,
        mac: frame.body.mac,
      });
      const inner = KNXIPFrame.fromKnx(plain).frame;
      if (inner.body instanceof SessionAuthenticate) {
        const expectedMac = computeAuthenticateMac({
          userPasswordKey: this.userPasswordKey,
          userId: inner.body.userId,
          clientPublicKey: this.clientPub!,
          serverPublicKey: this.serverPub,
        });
        const macOK = expectedMac.equals(inner.body.mac);
        const userOK = inner.body.userId === this.opts.expectedUserId;
        const status =
          macOK && userOK && !this.opts.rejectAuth ? 0x00 /* success */ : 0x01 /* failed */;
        this.serverWrapperSeq = (this.serverWrapperSeq ?? 0) + 1;
        void this.sendWrapped(
          KNXIPFrame.fromBody(new SessionStatus({ status })),
          this.serverWrapperSeq,
        );
        return;
      }
      this.receivedFromClient.push(inner);
      return;
    }
  }

  private serverWrapperSeq?: number;

  /** Send a wrapped frame from server → client (e.g. simulated incoming TUNNELLING_REQUEST). */
  async sendWrapped(frame: KNXIPFrame, sequenceId: number): Promise<void> {
    if (!this.sessionKey) throw new Error('no session key');
    const { encryptedFrame, mac } = encryptSecureWrapper({
      sessionKey: this.sessionKey,
      sessionId: this.sessionId,
      sequenceId,
      serialNumber: 1,
      messageTag: 0,
      plainFrame: frame.toKnx(),
    });
    const wrapper = new SecureWrapper({
      sessionId: this.sessionId,
      sequenceId,
      serialNumber: 1,
      messageTag: 0,
      encryptedFrame,
      mac,
    });
    return this.transport.send(KNXIPFrame.fromBody(wrapper));
  }
}

function pair(): { client: MockTransport; server: FakeServer } {
  const server = new FakeServer({
    deviceAuthPassword: 'device-pass',
    userPassword: 'user-pass',
    expectedUserId: 2,
  });
  const client = new MockTransport();
  client.peer = server.transport;
  server.transport.peer = client;
  return { client, server };
}

describe('SecureSession handshake', () => {
  it('completes the four-message handshake and reaches authenticated', async () => {
    const { client, server } = pair();
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'device-pass',
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    await client.bind();
    await session.open();
    assert.equal(session.state, 'authenticated');
    assert.equal(session.sessionId, server.sessionId);
    assert.deepEqual(session.sessionKey, server.sessionKey);
    await session.close();
  });

  // Regression: SESSION_AUTHENTICATE must travel inside a SECURE_WRAPPER per
  // KNX/IP Secure §2.5.6, NOT plain. Real gateways silently drop a plain
  // SESSION_AUTHENTICATE and reply with SESSION_STATUS=TIMEOUT, which is hard
  // to diagnose from logs alone — pin the wire shape here.
  it('transmits SESSION_AUTHENTICATE inside a SECURE_WRAPPER (spec §2.5.6)', async () => {
    const { client, server } = pair();
    const sentFromClient: KNXIPFrame[] = [];
    const origSend = client.send.bind(client);
    client.send = (frame: KNXIPFrame, addr?: SocketAddress) => {
      sentFromClient.push(KNXIPFrame.fromKnx(frame.toKnx()).frame);
      return origSend(frame, addr);
    };
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'device-pass',
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    await client.bind();
    await session.open();

    // First TX: plain SESSION_REQUEST. Second TX: SECURE_WRAPPER carrying
    // SESSION_AUTHENTICATE — never a plain SESSION_AUTHENTICATE.
    const sessionAuthIdx = sentFromClient.findIndex(
      (f) => f.body instanceof SessionAuthenticate,
    );
    assert.equal(
      sessionAuthIdx,
      -1,
      'SESSION_AUTHENTICATE must NOT be sent plain — wrap it in a SECURE_WRAPPER',
    );
    assert.equal(sentFromClient[0]!.body instanceof SessionRequest, true, '1st TX should be SESSION_REQUEST');
    assert.equal(
      sentFromClient[1]!.body instanceof SecureWrapper,
      true,
      '2nd TX should be SECURE_WRAPPER (carrying SESSION_AUTHENTICATE)',
    );
    // Decrypt with the freshly-negotiated session key the server derived; the
    // inner frame must be SESSION_AUTHENTICATE.
    const wrap = sentFromClient[1]!.body as SecureWrapper;
    assert.notEqual(server.sessionKey, null, 'server should have a session key by now');
    const plain = decryptSecureWrapper({
      sessionKey: server.sessionKey!,
      sessionId: wrap.sessionId,
      sequenceId: wrap.sequenceId,
      serialNumber: wrap.serialNumber,
      messageTag: wrap.messageTag,
      encryptedFrame: wrap.encryptedFrame,
      mac: wrap.mac,
    });
    const inner = KNXIPFrame.fromKnx(plain).frame;
    assert.equal(inner.body instanceof SessionAuthenticate, true);
    await session.close();
  });

  it('rejects when the device-auth password is wrong (MAC mismatch)', async () => {
    const { client } = pair();
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'wrong-device-pass',
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    session.on('error', () => {}); // suppress un-listened error
    await client.bind();
    await assert.rejects(session.open(), /SESSION_RESPONSE MAC verification failed/);
  });

  // Single-password / non-ETS devices don't expose a Device Authentication
  // Code in their UI. When the user omits it, we must skip the
  // SESSION_RESPONSE MAC check and still complete the handshake — the user
  // password authenticates the client, and the session is still encrypted.
  it('skips SESSION_RESPONSE MAC check when no device-auth password is configured', async () => {
    const { client } = pair(); // server still uses 'device-pass' internally
    const session = new SecureSession(client, {
      userId: 2,
      // deviceAuthPassword intentionally omitted
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    await client.bind();
    await session.open();
    assert.equal(session.state, 'authenticated');
    await session.close();
  });

  it('rejects when the user password is wrong (server returns AUTHENTICATION_FAILED)', async () => {
    const server = new FakeServer({
      deviceAuthPassword: 'device-pass',
      userPassword: 'right-user-pass',
      expectedUserId: 2,
    });
    const client = new MockTransport();
    client.peer = server.transport;
    server.transport.peer = client;

    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'device-pass',
      userPassword: 'wrong-user-pass',
      keepaliveMs: 0,
    });
    session.on('error', () => {});
    await client.bind();
    await assert.rejects(session.open(), /AUTHENTICATION_FAILED|authentication rejected/);
  });

  it('times out when no SESSION_RESPONSE arrives', async () => {
    const client = new MockTransport();
    // No peer wired up — server never responds.
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'p',
      userPassword: 'p',
      handshakeTimeoutMs: 100,
      keepaliveMs: 0,
    });
    session.on('error', () => {});
    await client.bind();
    await assert.rejects(session.open(), /handshake timeout/i);
  });
});

describe('SecureSession encrypted send/receive', () => {
  // Avoid awaiting cross-task message delivery in the mock — node:test's
  // event-loop tracker can prematurely cancel awaits while setImmediate /
  // microtasks chain. Capture the bytes the client tries to transmit and
  // decrypt them directly with the server's session key.

  it('encrypts client → server frames into a SecureWrapper that decrypts back to the original', async () => {
    const { client, server } = pair();
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'device-pass',
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    await client.bind();
    await session.open();
    assert.ok(server.sessionKey, 'server should have derived a session key');

    // From this point intercept what would be transmitted, so we can decrypt
    // directly without waiting for microtask/setImmediate event delivery.
    const captured: KNXIPFrame[] = [];
    client.send = (frame) => {
      captured.push(frame);
      return Promise.resolve();
    };

    const tr = new TunnellingRequest({
      communicationChannelId: 1,
      sequenceCounter: 0,
      rawCemi: Buffer.from('29 00 bc e0 00 00 00 03 01 00 81'.replace(/\s+/g, ''), 'hex'),
    });
    await session.send(KNXIPFrame.fromBody(tr));

    assert.equal(captured.length, 1);
    const wrapper = captured[0]!.body as SecureWrapper;
    assert.ok(wrapper instanceof SecureWrapper, 'transmitted frame must be a SecureWrapper');
    assert.equal(wrapper.sessionId, server.sessionId);

    const plain = decryptSecureWrapper({
      sessionKey: server.sessionKey!,
      sessionId: wrapper.sessionId,
      sequenceId: wrapper.sequenceId,
      serialNumber: wrapper.serialNumber,
      messageTag: wrapper.messageTag,
      encryptedFrame: wrapper.encryptedFrame,
      mac: wrapper.mac,
    });
    const inner = KNXIPFrame.fromKnx(plain).frame;
    assert.equal(inner.header.serviceType, ServiceType.TUNNELLING_REQUEST);
    assert.ok(inner.body instanceof TunnellingRequest);
  });

  it('decrypts a server-built SecureWrapper into a "message" event', async () => {
    const { client, server } = pair();
    const session = new SecureSession(client, {
      userId: 2,
      deviceAuthPassword: 'device-pass',
      userPassword: 'user-pass',
      keepaliveMs: 0,
    });
    await client.bind();
    await session.open();

    const received: KNXIPFrame[] = [];
    session.on('message', (frame: KNXIPFrame) => received.push(frame));

    // Synthesise a SecureWrapper using the server's session key directly,
    // then deliver it synchronously via client.emit('message', ...) — bypasses
    // the queued event delivery that confused the test runner.
    const tr = new TunnellingRequest({
      communicationChannelId: 1,
      sequenceCounter: 5,
      rawCemi: Buffer.from('29 00 bc e0 11 11 22 22 01 00 80'.replace(/\s+/g, ''), 'hex'),
    });
    const inner = KNXIPFrame.fromBody(tr).toKnx();
    const enc = encryptSecureWrapper({
      sessionKey: server.sessionKey!,
      sessionId: server.sessionId,
      sequenceId: 0,
      serialNumber: 1,
      messageTag: 0,
      plainFrame: inner,
    });
    const wrapperFrame = KNXIPFrame.fromBody(
      new SecureWrapper({
        sessionId: server.sessionId,
        sequenceId: 0,
        serialNumber: 1,
        messageTag: 0,
        encryptedFrame: enc.encryptedFrame,
        mac: enc.mac,
      }),
    );
    const onWire = KNXIPFrame.fromKnx(wrapperFrame.toKnx()).frame;
    client.emit('message', onWire, { address: '127.0.0.1', port: 0 });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.header.serviceType, ServiceType.TUNNELLING_REQUEST);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SecureSessionStatus,
  SecureWrapper,
  SessionAuthenticate,
  SessionRequest,
  SessionResponse,
  SessionStatus,
  TimerNotify,
  secureSessionStatusName,
} from '../../src/core/bodies';
import { HPAI } from '../../src/core/hpai';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ServiceType } from '../../src/core/serviceTypes';

const macFill = (b: number) => Buffer.alloc(16, b);
const pubKeyFill = (b: number) => Buffer.alloc(32, b);

describe('SecureWrapper', () => {
  it('round-trips through KNXIPFrame', () => {
    const inner = Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 0x06]); // dummy
    const wrapper = new SecureWrapper({
      sessionId: 0x1234,
      sequenceId: 0xdeadbeef99,
      serialNumber: 0x010203040506,
      messageTag: 0xabcd,
      encryptedFrame: inner,
      mac: macFill(0xaa),
    });
    const frame = KNXIPFrame.fromBody(wrapper);
    assert.equal(frame.header.serviceType, ServiceType.SECURE_WRAPPER);
    const buf = frame.toKnx();
    const { frame: parsed } = KNXIPFrame.fromKnx(buf);
    assert.ok(parsed.body instanceof SecureWrapper);
    const back = parsed.body as SecureWrapper;
    assert.equal(back.sessionId, 0x1234);
    assert.equal(back.sequenceId, 0xdeadbeef99);
    assert.equal(back.serialNumber, 0x010203040506);
    assert.equal(back.messageTag, 0xabcd);
    assert.deepEqual(Array.from(back.encryptedFrame), Array.from(inner));
    assert.deepEqual(Array.from(back.mac), Array.from(macFill(0xaa)));
  });

  it('rejects MAC of wrong size', () => {
    assert.throws(
      () =>
        new SecureWrapper({
          sessionId: 0,
          sequenceId: 0,
          serialNumber: 0,
          messageTag: 0,
          encryptedFrame: Buffer.alloc(0),
          mac: Buffer.alloc(15),
        }),
      RangeError,
    );
  });
});

describe('SessionRequest', () => {
  it('round-trips with route-back HPAI', () => {
    const req = new SessionRequest({ publicKey: pubKeyFill(0x11) });
    const buf = KNXIPFrame.fromBody(req).toKnx();
    const { frame } = KNXIPFrame.fromKnx(buf);
    assert.ok(frame.body instanceof SessionRequest);
    const back = frame.body as SessionRequest;
    assert.equal(back.controlEndpoint.isRouteBack, true);
    assert.deepEqual(Array.from(back.publicKey), Array.from(pubKeyFill(0x11)));
  });

  it('round-trips with explicit endpoint', () => {
    const req = new SessionRequest({
      controlEndpoint: new HPAI('10.0.0.1', 50100),
      publicKey: pubKeyFill(0x22),
    });
    const buf = KNXIPFrame.fromBody(req).toKnx();
    const { frame } = KNXIPFrame.fromKnx(buf);
    const back = frame.body as SessionRequest;
    assert.equal(back.controlEndpoint.ip, '10.0.0.1');
    assert.equal(back.controlEndpoint.port, 50100);
  });

  it('rejects wrong-size public key', () => {
    assert.throws(
      () => new SessionRequest({ publicKey: Buffer.alloc(31) }),
      RangeError,
    );
  });
});

describe('SessionResponse', () => {
  it('round-trips', () => {
    const resp = new SessionResponse({
      sessionId: 0x0042,
      publicKey: pubKeyFill(0x33),
      mac: macFill(0x44),
    });
    const buf = KNXIPFrame.fromBody(resp).toKnx();
    const { frame } = KNXIPFrame.fromKnx(buf);
    const back = frame.body as SessionResponse;
    assert.equal(back.sessionId, 0x0042);
    assert.deepEqual(Array.from(back.publicKey), Array.from(pubKeyFill(0x33)));
    assert.deepEqual(Array.from(back.mac), Array.from(macFill(0x44)));
  });
});

describe('SessionAuthenticate', () => {
  it('round-trips', () => {
    const auth = new SessionAuthenticate({ userId: 7, mac: macFill(0x55) });
    const buf = KNXIPFrame.fromBody(auth).toKnx();
    const { frame } = KNXIPFrame.fromKnx(buf);
    const back = frame.body as SessionAuthenticate;
    assert.equal(back.userId, 7);
    assert.deepEqual(Array.from(back.mac), Array.from(macFill(0x55)));
  });

  it('writes a zero reserved byte', () => {
    const auth = new SessionAuthenticate({ userId: 1, mac: macFill(0) });
    assert.equal(auth.toKnx()[0], 0);
  });

  it('rejects out-of-range user IDs', () => {
    assert.throws(
      () => new SessionAuthenticate({ userId: 0, mac: macFill(0) }),
      RangeError,
    );
    assert.throws(
      () => new SessionAuthenticate({ userId: 128, mac: macFill(0) }),
      RangeError,
    );
  });
});

describe('SessionStatus', () => {
  it('round-trips every defined status', () => {
    for (const code of Object.values(SecureSessionStatus)) {
      const buf = KNXIPFrame.fromBody(new SessionStatus({ status: code })).toKnx();
      const { frame } = KNXIPFrame.fromKnx(buf);
      const back = frame.body as SessionStatus;
      assert.equal(back.status, code);
    }
  });

  it('exposes human-readable names', () => {
    assert.equal(secureSessionStatusName(0x00), 'AUTHENTICATION_SUCCESS');
    assert.equal(secureSessionStatusName(0x05), 'CLOSE');
    assert.match(secureSessionStatusName(0x99), /UNKNOWN_/);
  });
});

describe('TimerNotify', () => {
  it('round-trips a 48-bit timer + serial', () => {
    const t = new TimerNotify({
      timer: 0x010203040506,
      serialNumber: 0x0a0b0c0d0e0f,
      messageTag: 0xbeef,
      mac: macFill(0x66),
    });
    const buf = KNXIPFrame.fromBody(t).toKnx();
    const { frame } = KNXIPFrame.fromKnx(buf);
    const back = frame.body as TimerNotify;
    assert.equal(back.timer, 0x010203040506);
    assert.equal(back.serialNumber, 0x0a0b0c0d0e0f);
    assert.equal(back.messageTag, 0xbeef);
    assert.deepEqual(Array.from(back.mac), Array.from(macFill(0x66)));
  });
});

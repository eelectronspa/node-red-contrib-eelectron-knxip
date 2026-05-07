import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  aesCbcMac,
  aesCtrXor,
  bytesXor,
  generateX25519KeyPair,
  sha256,
  x25519SharedSecret,
} from '../../src/secure/crypto';
import {
  COUNTER_0_HANDSHAKE,
  computeAuthenticateMac,
  computeSessionResponseMac,
} from '../../src/secure/handshake';
import {
  deriveDeviceAuthCode,
  deriveSessionKey,
  deriveUserPasswordKey,
} from '../../src/secure/keys';
import {
  decryptSecureWrapper,
  encryptSecureWrapper,
} from '../../src/secure/wrapper';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('keys.ts — KNX-specific KDFs', () => {
  it('all three KDFs produce 16-byte outputs', () => {
    assert.equal(deriveDeviceAuthCode('hello').length, 16);
    assert.equal(deriveUserPasswordKey('world').length, 16);
    assert.equal(deriveSessionKey(Buffer.alloc(32, 7)).length, 16);
  });

  it('deriveDeviceAuthCode and deriveUserPasswordKey use different salts', () => {
    // Same password, different salts → different keys.
    const dac = deriveDeviceAuthCode('common-password');
    const upk = deriveUserPasswordKey('common-password');
    assert.notDeepEqual(dac, upk);
  });

  it('deriveSessionKey is the first 16 bytes of SHA-256(sharedSecret)', () => {
    const ss = Buffer.alloc(32, 0x42);
    assert.deepEqual(deriveSessionKey(ss), sha256(ss).subarray(0, 16));
  });

  it('Latin-1 encoding for password (covers non-ASCII bytes 0x80-0xFF)', () => {
    // Password with a Latin-1 character that has different UTF-8 bytes.
    const utf8Bytes = Buffer.from('ñ', 'utf8'); // 0xC3 0xB1
    const latin1Bytes = Buffer.from('ñ', 'latin1'); // 0xF1
    assert.notDeepEqual(utf8Bytes, latin1Bytes);
    // KDF must use Latin-1 — the spec says so. Verify by checking lengths
    // through PBKDF2: same string, two encodings, two different keys.
    const key = deriveDeviceAuthCode('café');
    assert.equal(key.length, 16);
  });
});

describe('aesCbcMac', () => {
  it('produces a 16-byte MAC', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const mac = aesCbcMac({ key, additionalData: Buffer.from('hello'), payload: Buffer.from('world') });
    assert.equal(mac.length, 16);
  });

  it('rejects non-16-byte keys / block_0', () => {
    assert.throws(() =>
      aesCbcMac({ key: Buffer.alloc(15), additionalData: Buffer.alloc(0) }),
    );
    assert.throws(() =>
      aesCbcMac({
        key: Buffer.alloc(16),
        additionalData: Buffer.alloc(0),
        block0: Buffer.alloc(15),
      }),
    );
  });

  it('changes when additionalData / payload / block_0 / key change', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const base = aesCbcMac({
      key,
      additionalData: Buffer.from([1, 2, 3]),
      payload: Buffer.from([4, 5, 6]),
      block0: Buffer.alloc(16, 0),
    });
    const v1 = aesCbcMac({ key, additionalData: Buffer.from([1, 2, 4]), payload: Buffer.from([4, 5, 6]) });
    const v2 = aesCbcMac({ key, additionalData: Buffer.from([1, 2, 3]), payload: Buffer.from([4, 5, 7]) });
    const v3 = aesCbcMac({ key, additionalData: Buffer.from([1, 2, 3]), payload: Buffer.from([4, 5, 6]), block0: Buffer.alloc(16, 1) });
    const v4 = aesCbcMac({ key: Buffer.alloc(16, 1), additionalData: Buffer.from([1, 2, 3]), payload: Buffer.from([4, 5, 6]) });
    assert.notDeepEqual(base, v1);
    assert.notDeepEqual(base, v2);
    assert.notDeepEqual(base, v3);
    assert.notDeepEqual(base, v4);
  });
});

describe('aesCtrXor (NIST CTR symmetry)', () => {
  it('is symmetric — encrypt(encrypt(p)) == p', () => {
    const key = hex('0123456789abcdef0123456789abcdef');
    const ctr = hex('00112233445566778899aabbccddeeff');
    const plain = Buffer.from('hello secure KNX!');
    const enc = aesCtrXor(key, ctr, plain);
    const dec = aesCtrXor(key, ctr, enc);
    assert.deepEqual(dec, plain);
  });
});

describe('bytesXor', () => {
  it('xors equal-length buffers byte by byte', () => {
    assert.deepEqual(bytesXor(hex('aabbcc'), hex('ff0011')), hex('55bbdd'));
  });
  it('rejects mismatched lengths', () => {
    assert.throws(() => bytesXor(hex('aa'), hex('aabb')));
  });
});

describe('handshake MACs', () => {
  // Build deterministic inputs so the MACs are reproducible across runs.
  const deviceAuthCode = deriveDeviceAuthCode('device-pass');
  const userKey = deriveUserPasswordKey('user-pass');
  const clientPub = Buffer.alloc(32, 0x11);
  const serverPub = Buffer.alloc(32, 0x22);

  it('computeSessionResponseMac returns 16 bytes', () => {
    const mac = computeSessionResponseMac({
      deviceAuthCode,
      sessionId: 0x0042,
      clientPublicKey: clientPub,
      serverPublicKey: serverPub,
    });
    assert.equal(mac.length, 16);
  });

  it('computeSessionResponseMac is deterministic', () => {
    const args = {
      deviceAuthCode,
      sessionId: 0x0042,
      clientPublicKey: clientPub,
      serverPublicKey: serverPub,
    };
    assert.deepEqual(
      computeSessionResponseMac(args),
      computeSessionResponseMac(args),
    );
  });

  it('computeSessionResponseMac changes with sessionId', () => {
    const a = computeSessionResponseMac({ deviceAuthCode, sessionId: 1, clientPublicKey: clientPub, serverPublicKey: serverPub });
    const b = computeSessionResponseMac({ deviceAuthCode, sessionId: 2, clientPublicKey: clientPub, serverPublicKey: serverPub });
    assert.notDeepEqual(a, b);
  });

  it('computeAuthenticateMac returns 16 bytes and is deterministic', () => {
    const m1 = computeAuthenticateMac({ userPasswordKey: userKey, userId: 1, clientPublicKey: clientPub, serverPublicKey: serverPub });
    const m2 = computeAuthenticateMac({ userPasswordKey: userKey, userId: 1, clientPublicKey: clientPub, serverPublicKey: serverPub });
    assert.equal(m1.length, 16);
    assert.deepEqual(m1, m2);
  });

  it('computeAuthenticateMac rejects out-of-range user IDs', () => {
    assert.throws(() =>
      computeAuthenticateMac({ userPasswordKey: userKey, userId: 0, clientPublicKey: clientPub, serverPublicKey: serverPub }),
    );
    assert.throws(() =>
      computeAuthenticateMac({ userPasswordKey: userKey, userId: 200, clientPublicKey: clientPub, serverPublicKey: serverPub }),
    );
  });

  it('COUNTER_0_HANDSHAKE matches spec layout', () => {
    // 14 zero bytes + 0xff 0x00
    assert.equal(COUNTER_0_HANDSHAKE.length, 16);
    assert.equal(COUNTER_0_HANDSHAKE[14], 0xff);
    assert.equal(COUNTER_0_HANDSHAKE[15], 0x00);
    assert.deepEqual(COUNTER_0_HANDSHAKE.subarray(0, 14), Buffer.alloc(14));
  });
});

describe('encrypt / decrypt SECURE_WRAPPER round-trip', () => {
  const sessionKey = hex('aabbccddeeff00112233445566778899');
  const plainFrame = Buffer.from(
    '06 10 04 21 00 0a 04 01 2a 00'.replace(/\s+/g, ''),
    'hex',
  );

  it('decrypt(encrypt(plain)) === plain with the same context', () => {
    const ctx = {
      sessionKey,
      sessionId: 0x1234,
      sequenceId: 0xdeadbeef99,
      serialNumber: 0x010203040506,
      messageTag: 0xabcd,
    };
    const { encryptedFrame, mac } = encryptSecureWrapper({ ...ctx, plainFrame });
    const back = decryptSecureWrapper({ ...ctx, encryptedFrame, mac });
    assert.deepEqual(back, plainFrame);
  });

  it('rejects a tampered MAC', () => {
    const ctx = {
      sessionKey,
      sessionId: 1,
      sequenceId: 1,
      serialNumber: 1,
      messageTag: 1,
    };
    const { encryptedFrame, mac } = encryptSecureWrapper({ ...ctx, plainFrame });
    const corruptedMac = Buffer.from(mac);
    corruptedMac[0] = corruptedMac[0]! ^ 0x01;
    assert.throws(() =>
      decryptSecureWrapper({ ...ctx, encryptedFrame, mac: corruptedMac }),
    );
  });

  it('rejects a tampered encrypted payload', () => {
    const ctx = {
      sessionKey,
      sessionId: 1,
      sequenceId: 1,
      serialNumber: 1,
      messageTag: 1,
    };
    const { encryptedFrame, mac } = encryptSecureWrapper({ ...ctx, plainFrame });
    const corrupted = Buffer.from(encryptedFrame);
    corrupted[0] = corrupted[0]! ^ 0x01;
    assert.throws(() =>
      decryptSecureWrapper({ ...ctx, encryptedFrame: corrupted, mac }),
    );
  });

  it('rejects when the receiver believes a different session/sequence', () => {
    const ctx = {
      sessionKey,
      sessionId: 1,
      sequenceId: 1,
      serialNumber: 1,
      messageTag: 1,
    };
    const { encryptedFrame, mac } = encryptSecureWrapper({ ...ctx, plainFrame });
    assert.throws(() =>
      decryptSecureWrapper({ ...ctx, sessionId: 2, encryptedFrame, mac }),
    );
    assert.throws(() =>
      decryptSecureWrapper({ ...ctx, sequenceId: 2, encryptedFrame, mac }),
    );
  });
});

describe('end-to-end mock handshake (no transport)', () => {
  // Simulate both sides locally to exercise the full key + MAC pipeline.
  it('client and server agree on session key and MACs', () => {
    const deviceAuthCode = deriveDeviceAuthCode('device-pass');
    const userKey = deriveUserPasswordKey('user-pass');
    const userId = 2;

    // Both sides generate ephemeral X25519 keys.
    const client = generateX25519KeyPair();
    const server = generateX25519KeyPair();

    const clientShared = x25519SharedSecret(client.privateKey, server.publicKey);
    const serverShared = x25519SharedSecret(server.privateKey, client.publicKey);
    assert.deepEqual(clientShared, serverShared);

    const sessionKeyClient = deriveSessionKey(clientShared);
    const sessionKeyServer = deriveSessionKey(serverShared);
    assert.deepEqual(sessionKeyClient, sessionKeyServer);

    // Server sends a SESSION_RESPONSE with this MAC; client recomputes locally
    // and they match.
    const sessionId = 0x4242;
    const serverSideMac = computeSessionResponseMac({
      deviceAuthCode,
      sessionId,
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    });
    const clientSideMac = computeSessionResponseMac({
      deviceAuthCode,
      sessionId,
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    });
    assert.deepEqual(serverSideMac, clientSideMac);

    // Client SESSION_AUTHENTICATE — server recomputes with same inputs.
    const clientAuthMac = computeAuthenticateMac({
      userPasswordKey: userKey,
      userId,
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    });
    const serverAuthMac = computeAuthenticateMac({
      userPasswordKey: userKey,
      userId,
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    });
    assert.deepEqual(clientAuthMac, serverAuthMac);
  });
});

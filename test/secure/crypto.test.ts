import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  aesCcmDecrypt,
  aesCcmEncrypt,
  aesCmac,
  aesEncryptBlock,
  generateX25519KeyPair,
  pbkdf2,
  x25519SharedSecret,
} from '../../src/secure/crypto';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('aesEncryptBlock (AES-128-ECB single block)', () => {
  it('matches NIST FIPS 197 test vector', () => {
    // FIPS 197 Appendix C.1
    const key = hex('000102030405060708090a0b0c0d0e0f');
    const plain = hex('00112233445566778899aabbccddeeff');
    const expected = hex('69c4e0d86a7b0430d8cdb78070b4c55a');
    assert.deepEqual(aesEncryptBlock(key, plain), expected);
  });
});

describe('aesCmac (NIST SP 800-38B Appendix D.1)', () => {
  // Common key from the NIST examples
  const key = hex('2b7e1516 28aed2a6 abf71588 09cf4f3c');

  it('Mlen=0 (empty message)', () => {
    const expected = hex('bb1d6929 e9593728 7fa37d12 9b756746');
    assert.deepEqual(aesCmac(key, Buffer.alloc(0)), expected);
  });

  it('Mlen=128 (one full block)', () => {
    const msg = hex('6bc1bee2 2e409f96 e93d7e11 7393172a');
    const expected = hex('070a16b4 6b4d4144 f79bdd9d d04a287c');
    assert.deepEqual(aesCmac(key, msg), expected);
  });

  it('Mlen=320 (40 bytes — non-block-aligned)', () => {
    const msg = hex(
      '6bc1bee2 2e409f96 e93d7e11 7393172a' +
        'ae2d8a57 1e03ac9c 9eb76fac 45af8e51' +
        '30c81c46 a35ce411',
    );
    const expected = hex('dfa66747 de9ae630 30ca3261 1497c827');
    assert.deepEqual(aesCmac(key, msg), expected);
  });

  it('Mlen=512 (64 bytes — four full blocks)', () => {
    const msg = hex(
      '6bc1bee2 2e409f96 e93d7e11 7393172a' +
        'ae2d8a57 1e03ac9c 9eb76fac 45af8e51' +
        '30c81c46 a35ce411 e5fbc119 1a0a52ef' +
        'f69f2445 df4f9b17 ad2b417b e66c3710',
    );
    const expected = hex('51f0bebf 7e3b9d92 fc497417 79363cfe');
    assert.deepEqual(aesCmac(key, msg), expected);
  });
});

describe('aesCcmEncrypt / aesCcmDecrypt (round-trip)', () => {
  it('decrypts what it encrypts with the same key/nonce/aad', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const nonce = hex('000102030405060708090a0b0c'); // 13-byte nonce (KNX uses 13)
    const aad = Buffer.from('header bytes', 'utf8');
    const plaintext = Buffer.from('hello secure KNX world', 'utf8');

    const { ciphertext, tag } = aesCcmEncrypt({ key, nonce, aad, plaintext });
    assert.equal(tag.length, 16);
    assert.equal(ciphertext.length, plaintext.length);

    const decrypted = aesCcmDecrypt({ key, nonce, aad, ciphertext, tag });
    assert.deepEqual(decrypted, plaintext);
  });

  it('rejects a tampered tag', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const nonce = hex('000102030405060708090a0b0c');
    const aad = Buffer.from('aad', 'utf8');
    const plaintext = Buffer.from('payload', 'utf8');
    const { ciphertext, tag } = aesCcmEncrypt({ key, nonce, aad, plaintext });

    const corruptedTag = Buffer.from(tag);
    corruptedTag[0] = corruptedTag[0]! ^ 0x01;

    assert.throws(() =>
      aesCcmDecrypt({ key, nonce, aad, ciphertext, tag: corruptedTag }),
    );
  });

  it('rejects modified ciphertext', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const nonce = hex('000102030405060708090a0b0c');
    const aad = Buffer.alloc(0);
    const plaintext = Buffer.from('confidential', 'utf8');
    const { ciphertext, tag } = aesCcmEncrypt({ key, nonce, aad, plaintext });

    const corrupted = Buffer.from(ciphertext);
    corrupted[0] = corrupted[0]! ^ 0x01;

    assert.throws(() =>
      aesCcmDecrypt({ key, nonce, aad, ciphertext: corrupted, tag }),
    );
  });
});

describe('x25519SharedSecret (RFC 7748 §6.1)', () => {
  // Test vectors from RFC 7748 §6.1
  const alicePriv = hex(
    '77076d0a 7318a57d 3c16c172 51b26645 df4c2f87 ebc0992a b177fba5 1db92c2a',
  );
  const alicePub = hex(
    '8520f009 8930a754 748b7ddc b43ef75a 0dbf3a0d 26381af4 eba4a98e aa9b4e6a',
  );
  const bobPriv = hex(
    '5dab087e 624a8a4b 79e17f8b 83800ee6 6f3bb129 2618b6fd 1c2f8b27 ff88e0eb',
  );
  const bobPub = hex(
    'de9edb7d 7b7dc1b4 d35b61c2 ece43537 3f8343c8 5b78674d adfc7e14 6f882b4f',
  );
  const sharedSecret = hex(
    '4a5d9d5b a4ce2de1 728e3bf4 80350f25 e07e21c9 47d19e33 76f09b3c 1e161742',
  );

  it("Alice's view (her priv * Bob's pub)", () => {
    assert.deepEqual(x25519SharedSecret(alicePriv, bobPub), sharedSecret);
  });

  it("Bob's view (his priv * Alice's pub)", () => {
    assert.deepEqual(x25519SharedSecret(bobPriv, alicePub), sharedSecret);
  });
});

describe('generateX25519KeyPair', () => {
  it('returns 32-byte raw keys whose own ECDH agrees', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    assert.equal(a.privateKey.length, 32);
    assert.equal(a.publicKey.length, 32);
    assert.deepEqual(
      x25519SharedSecret(a.privateKey, b.publicKey),
      x25519SharedSecret(b.privateKey, a.publicKey),
    );
  });
});

describe('pbkdf2 (RFC 6070 SHA-1 vectors are widely used; verify a minimal SHA-256 round-trip)', () => {
  it('is deterministic for the same inputs', () => {
    const out1 = pbkdf2({
      password: 'password',
      salt: Buffer.from('salt'),
      iterations: 1000,
      keyLength: 32,
      digest: 'sha256',
    });
    const out2 = pbkdf2({
      password: 'password',
      salt: Buffer.from('salt'),
      iterations: 1000,
      keyLength: 32,
      digest: 'sha256',
    });
    assert.deepEqual(out1, out2);
    assert.equal(out1.length, 32);
  });

  it('changes with the iteration count', () => {
    const out1 = pbkdf2({
      password: 'p',
      salt: Buffer.from('s'),
      iterations: 1000,
      keyLength: 16,
      digest: 'sha256',
    });
    const out2 = pbkdf2({
      password: 'p',
      salt: Buffer.from('s'),
      iterations: 2000,
      keyLength: 16,
      digest: 'sha256',
    });
    assert.notDeepEqual(out1, out2);
  });
});

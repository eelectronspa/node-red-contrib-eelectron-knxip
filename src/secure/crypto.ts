// Crypto primitives for KNX/IP Secure.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// All algorithms are implemented strictly from public specifications:
//   - AES-128-CMAC: NIST SP 800-38B
//   - X25519 ECDH: RFC 7748
//   - AES-128-CCM: NIST SP 800-38C / RFC 3610
//   - PBKDF2-HMAC-SHA256: RFC 2898 / NIST SP 800-132
//
// Each function takes raw Buffers and returns raw Buffers. The KNX-specific
// glue (session-key derivation from a shared secret, sequence-counter nonce
// construction, etc.) lives in `secureSession.ts` — this module is just the
// well-tested primitive layer.

import * as crypto from 'node:crypto';

// ---------- AES single-block ----------

/** Encrypt a single 16-byte block with AES-128, no padding. */
export function aesEncryptBlock(key: Buffer, block: Buffer): Buffer {
  if (key.length !== 16) throw new RangeError('AES-128 key must be 16 bytes');
  if (block.length !== 16) throw new RangeError('AES block must be 16 bytes');
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

// ---------- AES-128-CMAC (NIST SP 800-38B) ----------

const CMAC_RB = 0x87; // generator polynomial constant for 128-bit blocks
const BLOCK_SIZE = 16;

function leftShiftBlock(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const v = buf[i]!;
    out[i] = ((v << 1) | carry) & 0xff;
    carry = (v & 0x80) !== 0 ? 1 : 0;
  }
  return out;
}

function xorBlock(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** Derive subkeys K1, K2 from a 16-byte AES key per SP 800-38B §6.1. */
function deriveCmacSubkeys(key: Buffer): { K1: Buffer; K2: Buffer } {
  const L = aesEncryptBlock(key, Buffer.alloc(BLOCK_SIZE));
  const K1 = leftShiftBlock(L);
  if ((L[0]! & 0x80) !== 0) K1[BLOCK_SIZE - 1] = K1[BLOCK_SIZE - 1]! ^ CMAC_RB;
  const K2 = leftShiftBlock(K1);
  if ((K1[0]! & 0x80) !== 0) K2[BLOCK_SIZE - 1] = K2[BLOCK_SIZE - 1]! ^ CMAC_RB;
  return { K1, K2 };
}

/**
 * Compute the AES-128-CMAC of `msg` under `key`. Returns the 16-byte tag.
 * Spec: NIST SP 800-38B §6.2.
 */
export function aesCmac(key: Buffer, msg: Buffer): Buffer {
  const { K1, K2 } = deriveCmacSubkeys(key);

  // n = number of blocks (at least 1, even for empty input — last block is padded).
  const n = Math.max(1, Math.ceil(msg.length / BLOCK_SIZE));
  const lastBlockFull = msg.length > 0 && msg.length % BLOCK_SIZE === 0;

  // CBC-style chain over all but the final block.
  // Explicit `Buffer` annotation: with @types/node 22+ generic-Buffer typing,
  // `Buffer.alloc` resolves to `Buffer<ArrayBuffer>` while function returns
  // are `Buffer<ArrayBufferLike>` — the union form lets us re-assign across
  // the loop without an unsafe cast.
  let chain: Buffer = Buffer.alloc(BLOCK_SIZE);
  for (let i = 0; i < n - 1; i++) {
    const block = msg.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
    chain = aesEncryptBlock(key, xorBlock(chain, block));
  }

  // Final block: XOR with K1 if exact-length, else pad+0x80 then XOR with K2.
  let finalBlock: Buffer;
  if (lastBlockFull) {
    finalBlock = xorBlock(msg.subarray((n - 1) * BLOCK_SIZE), K1);
  } else {
    const tail = msg.subarray((n - 1) * BLOCK_SIZE);
    const padded = Buffer.alloc(BLOCK_SIZE);
    tail.copy(padded);
    padded[tail.length] = 0x80;
    finalBlock = xorBlock(padded, K2);
  }
  return aesEncryptBlock(key, xorBlock(chain, finalBlock));
}

// ---------- AES-128-CCM (NIST SP 800-38C / RFC 3610) ----------

export interface CcmEncryptInput {
  /** 16-byte AES key. */
  key: Buffer;
  /** Nonce (7..13 bytes). KNX/IP Secure uses 13. */
  nonce: Buffer;
  /** Additional authenticated data — not encrypted, included in the MAC. */
  aad: Buffer;
  /** Plaintext to encrypt. */
  plaintext: Buffer;
  /** MAC tag length in bytes. KNX uses 16. */
  macLength?: number;
}

export interface CcmEncryptOutput {
  ciphertext: Buffer;
  tag: Buffer;
}

export function aesCcmEncrypt(opts: CcmEncryptInput): CcmEncryptOutput {
  const macLength = opts.macLength ?? 16;
  const cipher = crypto.createCipheriv('aes-128-ccm', opts.key, opts.nonce, {
    authTagLength: macLength,
  });
  if (opts.aad.length > 0) {
    cipher.setAAD(opts.aad, { plaintextLength: opts.plaintext.length });
  }
  const ciphertext = Buffer.concat([cipher.update(opts.plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export interface CcmDecryptInput {
  key: Buffer;
  nonce: Buffer;
  aad: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function aesCcmDecrypt(opts: CcmDecryptInput): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ccm', opts.key, opts.nonce, {
    authTagLength: opts.tag.length,
  });
  decipher.setAuthTag(opts.tag);
  if (opts.aad.length > 0) {
    decipher.setAAD(opts.aad, { plaintextLength: opts.ciphertext.length });
  }
  // Note: createDecipheriv(...).final() throws on tag mismatch in CCM mode.
  return Buffer.concat([decipher.update(opts.ciphertext), decipher.final()]);
}

// ---------- X25519 ECDH (RFC 7748) ----------

export interface X25519KeyPair {
  /** 32-byte raw private scalar. */
  privateKey: Buffer;
  /** 32-byte raw public point. */
  publicKey: Buffer;
}

function base64UrlToBuffer(s: string): Buffer {
  // Node's 'base64url' decoder accepts unpadded base64-url input.
  return Buffer.from(s, 'base64url');
}

function bufferToBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Generate a fresh X25519 key pair. Returns raw 32-byte buffers. */
export function generateX25519KeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  // JWK is the cleanest path to extract the raw 32-byte values without
  // hand-rolling SPKI/PKCS8 ASN.1 parsing.
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  if (typeof privJwk.d !== 'string' || typeof pubJwk.x !== 'string') {
    throw new Error('Could not extract raw X25519 key bytes from KeyObject');
  }
  return {
    privateKey: base64UrlToBuffer(privJwk.d),
    publicKey: base64UrlToBuffer(pubJwk.x),
  };
}

/** Wrap a 32-byte raw X25519 private key into a Node KeyObject. */
function importX25519PrivateRaw(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new RangeError('X25519 private key must be 32 bytes');
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: bufferToBase64Url(raw), x: '' },
    format: 'jwk',
  });
}

/** Wrap a 32-byte raw X25519 public key into a Node KeyObject. */
function importX25519PublicRaw(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new RangeError('X25519 public key must be 32 bytes');
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: bufferToBase64Url(raw) },
    format: 'jwk',
  });
}

/**
 * Compute the X25519 ECDH shared secret. Inputs are raw 32-byte keys; output
 * is the raw 32-byte shared secret.
 */
export function x25519SharedSecret(privateKey: Buffer, publicKey: Buffer): Buffer {
  return crypto.diffieHellman({
    privateKey: importX25519PrivateRaw(privateKey),
    publicKey: importX25519PublicRaw(publicKey),
  });
}

// ---------- PBKDF2-HMAC-SHA256 (RFC 2898 / NIST SP 800-132) ----------

export interface Pbkdf2Input {
  password: string | Buffer;
  salt: Buffer;
  iterations: number;
  keyLength: number;
  /** Hash function. KNX uses SHA256. Defaults to 'sha256'. */
  digest?: 'sha1' | 'sha256' | 'sha512';
}

/** PBKDF2 wrapper. Synchronous (acceptable for one-shot key derivation). */
export function pbkdf2(opts: Pbkdf2Input): Buffer {
  const password =
    typeof opts.password === 'string' ? Buffer.from(opts.password, 'utf8') : opts.password;
  return crypto.pbkdf2Sync(
    password,
    opts.salt,
    opts.iterations,
    opts.keyLength,
    opts.digest ?? 'sha256',
  );
}

// ---------- AES-128-CBC-MAC (KNX/IP Secure flavour) ----------

/**
 * KNX-flavoured AES-128 CBC-MAC. The input is concatenated as
 *   block_0 || u16be(len(additional_data)) || additional_data || payload
 * zero-padded to a 16-byte boundary, AES-CBC encrypted with IV = 0, and the
 * last cipher block is returned as the 16-byte MAC.
 *
 * Notes:
 *  - This is NOT NIST-CMAC. KNX/IP Secure uses raw CBC-MAC with a length-
 *    prefixed associated-data field, and the encryption of the MAC under a
 *    counter-mode keystream is the caller's responsibility (handshake uses
 *    `COUNTER_0_HANDSHAKE`, frame wrapping uses a per-frame counter_0).
 *  - `block_0` is a 16-byte structured input that varies per usage. Defaults
 *    to all zeros.
 */
export function aesCbcMac(opts: {
  key: Buffer;
  additionalData: Buffer;
  payload?: Buffer;
  block0?: Buffer;
}): Buffer {
  if (opts.key.length !== 16) throw new RangeError('CBC-MAC key must be 16 bytes');
  const block0 = opts.block0 ?? Buffer.alloc(16);
  if (block0.length !== 16) throw new RangeError('block_0 must be 16 bytes');
  const payload = opts.payload ?? Buffer.alloc(0);
  const adLen = Buffer.alloc(2);
  adLen.writeUInt16BE(opts.additionalData.length, 0);

  const concat = Buffer.concat([block0, adLen, opts.additionalData, payload]);
  // Zero-pad to a 16-byte boundary.
  const padLen = (16 - (concat.length % 16)) % 16;
  const padded = padLen === 0 ? concat : Buffer.concat([concat, Buffer.alloc(padLen)]);

  const cipher = crypto.createCipheriv('aes-128-cbc', opts.key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(padded), cipher.final()]);
  return out.subarray(out.length - 16);
}

// ---------- AES-128-CTR ----------

/**
 * AES-128-CTR — symmetric (encrypt = decrypt). KNX uses NIST-style CTR
 * (16-byte counter block, big-endian increment per AES block) with a
 * 16-byte initial counter the caller constructs from sequence info / serial /
 * message tag / suffix bytes.
 */
export function aesCtrXor(key: Buffer, counter0: Buffer, data: Buffer): Buffer {
  if (key.length !== 16) throw new RangeError('AES-128 CTR key must be 16 bytes');
  if (counter0.length !== 16) throw new RangeError('counter_0 must be 16 bytes');
  const cipher = crypto.createCipheriv('aes-128-ctr', key, counter0);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

// ---------- SHA-256 wrapper ----------

export function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

// ---------- Buffer helpers ----------

export function bytesXor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new RangeError(`bytesXor length mismatch: ${a.length} vs ${b.length}`);
  }
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

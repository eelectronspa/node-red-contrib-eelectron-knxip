// Minimal ZIP central-directory reader + WinZip AES (AE-2) decryptor for the
// inner archive ETS6 places inside .knxproj exports.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// The .knxproj outer ZIP is unencrypted but it only contains catalog data
// plus a nested archive (typically `P-XXXX.zip`) which holds the real project
// XMLs. ETS encrypts that nested archive with the project password using
// WinZip AES — compression method 99 in the central directory, with
// algorithm details in the 0x9901 extra field.
//
// Format references:
//   - PKWARE APPNOTE.TXT — standard ZIP layout
//   - WinZip AE-2 specification (winzip.com/aes_info.htm) — encryption layout:
//       file data = salt | passwordVerifier(2) | ciphertext | hmacSha1(10)
//       key derivation = PBKDF2-HMAC-SHA1(password, salt, 1000,
//                                          2*keyBytes + 2)
//       encryption = AES-CTR with little-endian counter starting at 1
//
// Salt size + AES key size depend on strength:
//   strength 1 → AES-128 (salt 8, key 16)
//   strength 2 → AES-192 (salt 12, key 24)
//   strength 3 → AES-256 (salt 16, key 32)

import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';

export class InnerZipBadPassword extends Error {
  readonly code = 'BAD_PASSWORD';
  constructor(entryName?: string) {
    super(
      entryName
        ? `Wrong password for encrypted entry "${entryName}"`
        : 'Wrong password for the encrypted .knxproj inner archive',
    );
    this.name = 'InnerZipBadPassword';
  }
}

export class InnerZipUnsupportedEncryption extends Error {
  readonly code = 'UNSUPPORTED_ENCRYPTION';
  constructor(message: string) {
    super(message);
    this.name = 'InnerZipUnsupportedEncryption';
  }
}

export interface InnerZipEntry {
  name: string;
  data: Buffer;
}

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const SALT_SIZE_BY_STRENGTH: Record<number, number> = { 1: 8, 2: 12, 3: 16 };
const ECB_CIPHER_BY_KEYSIZE: Record<number, string> = {
  16: 'aes-128-ecb',
  24: 'aes-192-ecb',
  32: 'aes-256-ecb',
};

interface CdEntry {
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  name: string;
  extra: Buffer;
  localOffset: number;
}

interface AesExtra {
  strength: number; // 1 = AES-128, 2 = AES-192, 3 = AES-256
  actualMethod: number; // method to use after decryption (0 = stored, 8 = deflate)
}

function findEocd(buf: Buffer): number {
  // Scan from the end: EOCD has 22 bytes minimum, with optional comment up to 65535.
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new InnerZipUnsupportedEncryption('Could not locate End of Central Directory');
}

function readCentralDirectory(buf: Buffer, eocdOffset: number): CdEntry[] {
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const numEntries = buf.readUInt16LE(eocdOffset + 10);

  const entries: CdEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) {
      throw new InnerZipUnsupportedEncryption(
        `Central-directory record ${i} has wrong signature at offset ${offset}`,
      );
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const extra = Buffer.from(
      buf.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen),
    );
    entries.push({
      flags,
      method,
      compressedSize,
      uncompressedSize,
      name,
      extra,
      localOffset,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findAesExtra(extra: Buffer): AesExtra | null {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) break;
    if (id === 0x9901 && len >= 7) {
      // version(2) + vendor(2) + strength(1) + originalMethod(2)
      const strength = extra[i + 4 + 4] ?? 0;
      const actualMethod = extra.readUInt16LE(i + 4 + 5);
      return { strength, actualMethod };
    }
    i += 4 + len;
  }
  return null;
}

/**
 * AES-CTR decryption per WinZip AE-2: 16-byte counter block, little-endian
 * counter starting at 1, incremented per AES block. (Node's built-in
 * `aes-*-ctr` cipher uses the NIST big-endian counter convention, which
 * doesn't match — hence the manual implementation.)
 */
function aesCtrDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const cipherName = ECB_CIPHER_BY_KEYSIZE[key.length];
  if (!cipherName) {
    throw new InnerZipUnsupportedEncryption(`Unsupported AES key size ${key.length}`);
  }
  const out = Buffer.alloc(ciphertext.length);
  const counter = Buffer.alloc(16);
  // 16-byte little-endian counter — JS bigint avoids the 53-bit Number cap.
  let blockNum = 1n;
  for (let i = 0; i < ciphertext.length; i += 16) {
    let n = blockNum;
    for (let j = 0; j < 16; j++) {
      counter[j] = Number(n & 0xffn);
      n >>= 8n;
    }
    const ecb = crypto.createCipheriv(cipherName, key, null);
    ecb.setAutoPadding(false);
    const keystream = Buffer.concat([ecb.update(counter), ecb.final()]);
    const end = Math.min(i + 16, ciphertext.length);
    for (let j = i; j < end; j++) {
      out[j] = ciphertext[j]! ^ keystream[j - i]!;
    }
    blockNum += 1n;
  }
  return out;
}

/**
 * Read every file out of a ZIP buffer, transparently decrypting WinZip AES
 * entries when a password is supplied. Throws {@link InnerZipBadPassword}
 * for password-related failures.
 */
export function extractInnerZip(buf: Buffer, password?: string): InnerZipEntry[] {
  const eocd = findEocd(buf);
  const cd = readCentralDirectory(buf, eocd);
  const out: InnerZipEntry[] = [];

  for (const entry of cd) {
    if (entry.name.endsWith('/')) continue; // directory marker

    // Local file header tells us where the file data actually starts.
    const lfh = entry.localOffset;
    if (buf.readUInt32LE(lfh) !== LFH_SIG) {
      throw new InnerZipUnsupportedEncryption(
        `Local file header for "${entry.name}" missing or malformed`,
      );
    }
    const lfhNameLen = buf.readUInt16LE(lfh + 26);
    const lfhExtraLen = buf.readUInt16LE(lfh + 28);
    const dataOffset = lfh + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataOffset + entry.compressedSize;

    let payload: Buffer;
    let actualMethod = entry.method;

    const isEncrypted = (entry.flags & 0x01) !== 0;
    if (isEncrypted) {
      if (!password) {
        throw new InnerZipBadPassword(entry.name);
      }
      const aes = findAesExtra(entry.extra);
      if (!aes) {
        throw new InnerZipUnsupportedEncryption(
          `Entry "${entry.name}" is encrypted with legacy ZipCrypto, which isn't supported in this nested-archive path. Re-export from ETS6 (which uses AES) if possible.`,
        );
      }
      const saltSize = SALT_SIZE_BY_STRENGTH[aes.strength];
      if (!saltSize) {
        throw new InnerZipUnsupportedEncryption(
          `Unknown AES strength ${aes.strength} on "${entry.name}"`,
        );
      }
      const keyBytes = saltSize * 2; // 8→16, 12→24, 16→32

      // Layout: salt | verifier(2) | ciphertext | hmac(10)
      const salt = buf.subarray(dataOffset, dataOffset + saltSize);
      const verifier = buf.subarray(dataOffset + saltSize, dataOffset + saltSize + 2);
      const macStart = dataEnd - 10;
      const ciphertext = buf.subarray(dataOffset + saltSize + 2, macStart);
      const mac = buf.subarray(macStart, dataEnd);

      const dk = crypto.pbkdf2Sync(
        Buffer.from(password, 'utf8'),
        salt,
        1000,
        2 * keyBytes + 2,
        'sha1',
      );
      const encKey = dk.subarray(0, keyBytes);
      const authKey = dk.subarray(keyBytes, 2 * keyBytes);
      const expectedVerifier = dk.subarray(2 * keyBytes);

      if (!verifier.equals(expectedVerifier)) {
        throw new InnerZipBadPassword(entry.name);
      }

      const computedMac = crypto
        .createHmac('sha1', authKey)
        .update(ciphertext)
        .digest()
        .subarray(0, 10);
      if (!computedMac.equals(mac)) {
        throw new InnerZipUnsupportedEncryption(
          `HMAC verification failed for "${entry.name}" — file may be corrupted`,
        );
      }

      payload = aesCtrDecrypt(encKey, Buffer.from(ciphertext));
      actualMethod = aes.actualMethod;
    } else {
      payload = Buffer.from(buf.subarray(dataOffset, dataEnd));
    }

    let plaintext: Buffer;
    if (actualMethod === 0) {
      plaintext = payload;
    } else if (actualMethod === 8) {
      plaintext = zlib.inflateRawSync(payload);
    } else {
      throw new InnerZipUnsupportedEncryption(
        `Unsupported compression method ${actualMethod} for "${entry.name}"`,
      );
    }

    out.push({ name: entry.name, data: plaintext });
  }

  return out;
}

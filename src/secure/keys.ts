// KNX/IP Secure key-derivation helpers.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// The KDFs are documented in the KNX/IP Secure specification (KNX 03_08_05);
// each is a PBKDF2-HMAC-SHA256 with a fixed salt and 65 536 iterations, the
// password encoded as Latin-1 bytes, output truncated to 16 bytes.

import { pbkdf2, sha256 } from './crypto';

const ITERATIONS = 65_536;
const OUTPUT_LEN = 16;

/**
 * Derive the device-authentication code from the user-typed Device
 * Authentication password.
 *
 * Salt:        "device-authentication-code.1.secure.ip.knx.org"
 * Encoding:    Latin-1
 * Hash:        SHA-256
 * Iterations:  65 536
 * Output:      16 bytes
 */
export function deriveDeviceAuthCode(password: string): Buffer {
  return pbkdf2({
    password: Buffer.from(password, 'latin1'),
    salt: Buffer.from('device-authentication-code.1.secure.ip.knx.org', 'ascii'),
    iterations: ITERATIONS,
    keyLength: OUTPUT_LEN,
    digest: 'sha256',
  });
}

/**
 * Derive a user's authentication key from their plaintext password.
 *
 * Salt:        "user-password.1.secure.ip.knx.org"
 * Same hash / iterations / encoding / output length as the device auth code.
 */
export function deriveUserPasswordKey(password: string): Buffer {
  return pbkdf2({
    password: Buffer.from(password, 'latin1'),
    salt: Buffer.from('user-password.1.secure.ip.knx.org', 'ascii'),
    iterations: ITERATIONS,
    keyLength: OUTPUT_LEN,
    digest: 'sha256',
  });
}

/**
 * Compute the per-session AES key from an X25519 ECDH shared secret:
 *   session_key = SHA-256(shared_secret)[:16]
 */
export function deriveSessionKey(sharedSecret: Buffer): Buffer {
  return sha256(sharedSecret).subarray(0, 16);
}

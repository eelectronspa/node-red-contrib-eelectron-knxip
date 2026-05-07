// Parser for ETS6 .knxproj project archives.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// A .knxproj is a ZIP archive containing one or more XML files. The project
// XML (typically `P-XXXX/0.xml` where XXXX is a project id) holds the group-
// address tree under
//   Project/Installations/Installation/GroupAddresses/GroupRanges/(...)/GroupAddress
//
// Each `<GroupAddress>` carries:
//   - Address (decimal uint16, raw form)
//   - Name (display name)
//   - Description (optional)
//   - DatapointType (optional — e.g. "DPST-1-1")
//
// Some projects don't carry the DatapointType directly on the GA (it lives on
// bound ComObjects instead). We extract whatever is present on the GA element
// and surface a warning when DPTs are missing.
//
// Password-protected archives are detected via the PKZip "encrypted" flag.
// ZipCrypto-encrypted entries (the original PKZip stream cipher) are decrypted
// via adm-zip. WinZip AES-encrypted entries (extra field 0x9901) are detected
// and reported with a specific error so callers know which capability is
// missing.

import * as crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import {
  InnerZipBadPassword,
  InnerZipUnsupportedEncryption,
  extractInnerZip,
} from './winzipAes';

/**
 * ETS6 derives the actual PKZip-AES password by running the user-typed
 * password through a fixed-parameter PBKDF2-HMAC-SHA256, then base64-encoding
 * the result. The derived value is what the standard WinZip AE-2 key
 * derivation receives, so plain WinZip readers can't open the archive even
 * if they support method 99 — they're missing this stage.
 *
 * Parameters are constants of the file format:
 *   - hash:        SHA-256
 *   - password:    user password encoded as UTF-16 little-endian
 *   - salt:        ASCII bytes of the literal string "21.project.ets.knx.org"
 *   - iterations:  65 536
 *   - output:      32 bytes, base64-encoded (with standard '+/' alphabet
 *                  and no line breaks; '=' padding kept)
 */
function deriveEts6ZipPassword(password: string): string {
  const pwUtf16Le = Buffer.from(password, 'utf16le');
  const salt = Buffer.from('21.project.ets.knx.org', 'ascii');
  const dk = crypto.pbkdf2Sync(pwUtf16Le, salt, 65536, 32, 'sha256');
  return dk.toString('base64');
}

/** Thrown when the archive is encrypted but no password was provided. */
export class KnxprojPasswordRequired extends Error {
  readonly code = 'PASSWORD_REQUIRED';
  constructor() {
    super('The .knxproj archive is password-protected — provide a password to decrypt it.');
    this.name = 'KnxprojPasswordRequired';
  }
}

/** Thrown when the supplied password didn't decrypt the archive. */
export class KnxprojBadPassword extends Error {
  readonly code = 'BAD_PASSWORD';
  constructor() {
    super('The .knxproj password is incorrect.');
    this.name = 'KnxprojBadPassword';
  }
}

/** Thrown when the archive uses WinZip AES encryption (not yet implemented). */
export class KnxprojAesNotSupported extends Error {
  readonly code = 'AES_NOT_SUPPORTED';
  readonly keyStrength: number;
  constructor(keyStrength: number) {
    super(
      `The .knxproj archive uses WinZip AES-${keyStrength === 1 ? 128 : keyStrength === 2 ? 192 : 256} encryption, which this version doesn't decrypt yet. Re-export the project from ETS using "ZipCrypto" / "Standard" password protection if your tooling allows, or send a small sample so we can add AES support.`,
    );
    this.name = 'KnxprojAesNotSupported';
    this.keyStrength = keyStrength;
  }
}

interface ZipEntryHeaderLike {
  flags?: number;
}

/** Walk a PKZip "extra" field looking for the WinZip-AES marker (0x9901). */
function findAesExtra(extra: Buffer | undefined): { keyStrength: number } | null {
  if (!extra || extra.length < 4) return null;
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) break;
    if (id === 0x9901 && len >= 7) {
      // version(2) + vendor(2) + keyStrength(1) + origMethod(2)
      const keyStrength = extra[i + 4 + 4] ?? 0;
      return { keyStrength };
    }
    i += 4 + len;
  }
  return null;
}

/**
 * One IP-secure-capable device discovered in a .knxproj. Carries the values
 * a tunnel config needs to populate its KNX/IP Secure fields without the user
 * having to copy-paste them out of ETS.
 *
 * SECURITY NOTE: this struct contains plaintext credentials. Do not write it
 * to flow JSON. Persist it only in Node-RED credentials (encrypted at rest)
 * and surface it only to authenticated editor sessions.
 */
export interface KnxprojSecureInterface {
  /** "15.15.200" — device's main individual address. */
  individualAddress: string;
  /** From `<IPConfig IPAddress="...">`. */
  ipAddress: string | null;
  /** Optional human label (Name attribute, often blank). */
  name: string;
  /** Per-project DeviceAuthenticationCode (used as deviceAuthPassword). */
  deviceAuthenticationCode: string;
  /**
   * The DeviceManagementPassword. In KNX/IP Secure this is the password for
   * user_id=1 (the management user). Keeping it separate so the editor can
   * present it as a distinct picker option.
   */
  deviceManagementPassword: string;
  /**
   * Tunneling users programmed into this device, in BusInterface order.
   * `userId` is the wire user-id (BI-N → user_id N+1; BI-1 → 2, BI-2 → 3, …)
   * since user_id=1 is reserved for management.
   */
  tunnelingUsers: Array<{
    interfaceIndex: number;
    userId: number;
    password: string;
  }>;
}

export interface KnxprojGroupAddress {
  /** Long-form GA string ("M/M/S"). */
  ga: string;
  /** Raw uint16 address. */
  raw: number;
  /** Display name from the GA's Name attribute. */
  name: string;
  /** Description attribute (often empty). */
  description: string;
  /** DPT id as written in the project (e.g. "DPST-1-1"), or null if absent. */
  dpt: string | null;
}

export interface KnxprojParseResult {
  groupAddresses: KnxprojGroupAddress[];
  /** Project name from `<ProjectInformation Name="...">`, when present. */
  projectName: string | null;
  /**
   * Secure tunneling-capable devices discovered in the project. Empty array
   * when the project has no Security element or no IP devices.
   */
  secureInterfaces: KnxprojSecureInterface[];
  warnings: string[];
}

export interface ParseKnxprojOptions {
  /** Password to decrypt the archive, when it's password-protected. */
  password?: string;
}

/** Parse a .knxproj archive (provided as a Buffer). */
export function parseKnxproj(
  buffer: Buffer,
  opts: ParseKnxprojOptions = {},
): KnxprojParseResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(
      `Could not open .knxproj as a ZIP archive: ${(err as Error).message}`,
    );
  }

  const entries = zip.getEntries();
  const password = opts.password;

  // Up-front encryption survey — detect outer-level encryption (uncommon for
  // .knxproj but possible) and surface the right error.
  let outerEncrypted = false;
  for (const entry of entries) {
    const flags = (entry.header as ZipEntryHeaderLike).flags ?? 0;
    if ((flags & 0x01) !== 0) {
      outerEncrypted = true;
      const aes = findAesExtra(entry.extra);
      if (aes) {
        throw new KnxprojAesNotSupported(aes.keyStrength);
      }
    }
  }
  if (outerEncrypted && !password) {
    throw new KnxprojPasswordRequired();
  }

  // Build the list of XML files we'll walk. Two sources:
  //   1. Direct XML entries in the outer archive.
  //   2. XML entries inside any nested ZIP (typically `P-XXXX.zip`) — that's
  //      where ETS6 keeps the real project content, often AES-encrypted.
  interface XmlSource {
    name: string;
    data: Buffer;
  }
  const xmlSources: XmlSource[] = [];
  const warnings: string[] = [];
  let needsPassword = false;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const flags = (entry.header as ZipEntryHeaderLike).flags ?? 0;
    const isEncrypted = (flags & 0x01) !== 0;
    const lower = entry.entryName.toLowerCase();

    if (lower.endsWith('.xml')) {
      try {
        const buf = isEncrypted
          ? (entry.getData as (pwd?: string) => Buffer)(password)
          : entry.getData();
        xmlSources.push({ name: entry.entryName, data: buf });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (isEncrypted && /wrong password/i.test(msg)) {
          throw new KnxprojBadPassword();
        }
        warnings.push(`Could not read entry ${entry.entryName}: ${msg}`);
      }
      continue;
    }

    if (lower.endsWith('.zip')) {
      // Nested ZIP — ETS6 wraps the actual project XMLs in here, often AES-
      // encrypted via PKZip method 99. The PKZip password isn't the user
      // password directly; it's derived through deriveEts6ZipPassword first.
      const nestedBuf = entry.getData();
      const innerPwd = password ? deriveEts6ZipPassword(password) : undefined;
      try {
        const nested = extractInnerZip(nestedBuf, innerPwd);
        for (const e of nested) {
          if (e.name.toLowerCase().endsWith('.xml')) {
            xmlSources.push({ name: `${entry.entryName}::${e.name}`, data: e.data });
          }
        }
      } catch (err) {
        if (err instanceof InnerZipBadPassword) {
          if (!password) {
            needsPassword = true;
          } else {
            throw new KnxprojBadPassword();
          }
        } else if (err instanceof InnerZipUnsupportedEncryption) {
          warnings.push(
            `Skipped nested archive ${entry.entryName}: ${(err as Error).message}`,
          );
        } else {
          warnings.push(
            `Could not open nested archive ${entry.entryName}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  if (needsPassword) {
    throw new KnxprojPasswordRequired();
  }

  if (xmlSources.length === 0) {
    return {
      groupAddresses: [],
      projectName: null,
      secureInterfaces: [],
      warnings: warnings.length ? warnings : ['No XML files found inside the archive'],
    };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Force certain elements to always be arrays so single-child cases don't
    // collapse into objects (which would break the recursive walker).
    isArray: (name) =>
      name === 'GroupRange' ||
      name === 'GroupAddress' ||
      name === 'Area' ||
      name === 'Line' ||
      name === 'DeviceInstance' ||
      name === 'BusInterface',
  });

  const collected = new Map<number, KnxprojGroupAddress>();
  let projectName: string | null = null;
  const secureInterfaces: KnxprojSecureInterface[] = [];

  for (const xml of xmlSources) {
    let parsed: unknown;
    try {
      parsed = parser.parse(xml.data.toString('utf8'));
    } catch (err) {
      warnings.push(`Could not parse XML ${xml.name}: ${(err as Error).message}`);
      continue;
    }
    if (projectName === null) {
      projectName = extractProjectName(parsed);
    }
    walkForGroupAddresses(parsed, (ga) => {
      collected.set(ga.raw, ga);
    });
    extractSecureInterfaces(parsed, secureInterfaces);
  }

  const groupAddresses = [...collected.values()].sort((a, b) => a.raw - b.raw);
  if (groupAddresses.length === 0) {
    warnings.push('No <GroupAddress> elements found — is this a complete project export?');
  }
  return { groupAddresses, projectName, secureInterfaces, warnings };
}

function extractProjectName(parsed: unknown): string | null {
  const seen = new WeakSet<object>();
  function walk(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') return null;
    if (seen.has(obj as object)) return null;
    seen.add(obj as object);
    const rec = obj as Record<string, unknown>;
    const project = rec.Project as Record<string, unknown> | undefined;
    const info = project?.ProjectInformation as Record<string, unknown> | undefined;
    const name = info?.['@_Name'];
    if (typeof name === 'string') return name;
    for (const v of Object.values(rec)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  }
  return walk(parsed);
}

/**
 * Walk Project → Installations → Installation → Topology and pull each
 * `<DeviceInstance>` that carries its own `<Security>` block (i.e. is an IP
 * Secure interface). ETS stores DeviceAuthenticationCode + DeviceManagement-
 * Password per-device, with sibling `<IPConfig>` and `<BusInterfaces>`.
 */
function extractSecureInterfaces(parsed: unknown, out: KnxprojSecureInterface[]): void {
  const installations = collectInstallations(parsed);
  for (const inst of installations) {
    const topology = (inst as Record<string, unknown>).Topology as
      | Record<string, unknown>
      | undefined;
    if (!topology) continue;
    const areas = ensureArray(topology.Area);
    for (const area of areas) {
      const areaAddr = numericAttr(area, '@_Address');
      const lines = ensureArray((area as Record<string, unknown>).Line);
      for (const line of lines) {
        const lineAddr = numericAttr(line, '@_Address');
        for (const dev of collectDevicesOnLine(line)) {
          const iface = parseDeviceSecure(dev, areaAddr, lineAddr);
          if (iface) out.push(iface);
        }
      }
    }
  }
}

/**
 * DeviceInstance children of a Line are nested either directly or one level
 * deeper inside `<Segment>`. Some projects mix both; surface a flat list.
 */
function collectDevicesOnLine(line: unknown): unknown[] {
  const rec = line as Record<string, unknown>;
  const direct = ensureArray(rec.DeviceInstance);
  const segments = ensureArray(rec.Segment);
  const fromSegments: unknown[] = [];
  for (const seg of segments) {
    fromSegments.push(
      ...ensureArray((seg as Record<string, unknown>).DeviceInstance),
    );
  }
  return [...direct, ...fromSegments];
}

function parseDeviceSecure(
  dev: unknown,
  areaAddr: number | null,
  lineAddr: number | null,
): KnxprojSecureInterface | null {
  if (!dev || typeof dev !== 'object') return null;
  const rec = dev as Record<string, unknown>;
  const ipConfig = rec.IPConfig as Record<string, unknown> | undefined;
  if (!ipConfig) return null; // Not an IP device — skip.
  const sec = rec.Security as Record<string, unknown> | undefined;
  if (!sec) return null; // No security block — not an IP Secure device.

  const dac = stringAttr(sec, '@_DeviceAuthenticationCode');
  const dmp = stringAttr(sec, '@_DeviceManagementPassword');
  if (!dac && !dmp) return null;

  const busInterfaces = ensureArray(
    (rec.BusInterfaces as Record<string, unknown> | undefined)?.BusInterface,
  );

  const deviceAddr = numericAttr(rec, '@_Address');
  const ia =
    areaAddr !== null && lineAddr !== null && deviceAddr !== null
      ? `${areaAddr}.${lineAddr}.${deviceAddr}`
      : '?';

  const tunnelingUsers = busInterfaces
    .map((bi, idx) => {
      const password = stringAttr(bi, '@_Password');
      if (!password) return null;
      const interfaceIndex = idx + 1;
      // BI-1 → user_id 2 (user 1 is reserved for management).
      return { interfaceIndex, userId: interfaceIndex + 1, password };
    })
    .filter((u): u is { interfaceIndex: number; userId: number; password: string } => u !== null);

  return {
    individualAddress: ia,
    ipAddress: stringAttr(ipConfig, '@_IPAddress') || null,
    name: stringAttr(rec, '@_Name'),
    deviceAuthenticationCode: dac,
    deviceManagementPassword: dmp,
    tunnelingUsers,
  };
}

function collectInstallations(parsed: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new WeakSet<object>();
  function walk(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    if (seen.has(obj as object)) return;
    seen.add(obj as object);
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }
    const rec = obj as Record<string, unknown>;
    const installations = rec.Installations as Record<string, unknown> | undefined;
    if (installations?.Installation) {
      for (const inst of ensureArray(installations.Installation)) out.push(inst);
    }
    for (const v of Object.values(rec)) walk(v);
  }
  walk(parsed);
  return out;
}

function ensureArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function stringAttr(rec: unknown, key: string): string {
  if (!rec || typeof rec !== 'object') return '';
  const v = (rec as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function numericAttr(rec: unknown, key: string): number | null {
  if (!rec || typeof rec !== 'object') return null;
  const v = (rec as Record<string, unknown>)[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type Visitor = (ga: KnxprojGroupAddress) => void;

function walkForGroupAddresses(obj: unknown, visit: Visitor): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkForGroupAddresses(item, visit);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === 'GroupAddress') {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        const ga = parseGroupAddressElement(item);
        if (ga) visit(ga);
      }
    } else {
      walkForGroupAddresses(value, visit);
    }
  }
}

function parseGroupAddressElement(obj: unknown): KnxprojGroupAddress | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const addrAttr = rec['@_Address'];
  if (addrAttr === undefined) return null;
  const raw =
    typeof addrAttr === 'number'
      ? addrAttr
      : Number.parseInt(String(addrAttr), 10);
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) return null;

  const main = (raw >> 11) & 0x1f;
  const middle = (raw >> 8) & 0x07;
  const sub = raw & 0xff;

  const dptAttr = rec['@_DatapointType'];
  return {
    ga: `${main}/${middle}/${sub}`,
    raw,
    name: typeof rec['@_Name'] === 'string' ? (rec['@_Name'] as string) : '',
    description:
      typeof rec['@_Description'] === 'string' ? (rec['@_Description'] as string) : '',
    dpt: typeof dptAttr === 'string' && dptAttr ? dptAttr : null,
  };
}

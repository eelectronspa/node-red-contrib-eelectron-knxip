// Parser for ETS6 .knxproj project archives.
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
// bound ComObjects instead). For v1 we extract whatever is present on the GA
// element and surface a warning when DPTs are missing.
//
// Encrypted/password-protected archives are detected via the ZIP encryption
// flag and rejected with a clear error.

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

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
  warnings: string[];
}

/** Parse a .knxproj archive (provided as a Buffer). */
export function parseKnxproj(buffer: Buffer): KnxprojParseResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(
      `Could not open .knxproj as a ZIP archive: ${(err as Error).message}`,
    );
  }

  const entries = zip.getEntries();
  // Detect file-level encryption (PKZip "general purpose" bit 0).
  for (const entry of entries) {
    const flags = (entry.header as { flags?: number }).flags ?? 0;
    if ((flags & 0x01) !== 0) {
      throw new Error(
        'The .knxproj file is password-protected. Export the project from ETS without a password to use it here.',
      );
    }
  }

  const xmlEntries = entries.filter(
    (e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml'),
  );
  if (xmlEntries.length === 0) {
    return {
      groupAddresses: [],
      projectName: null,
      warnings: ['No XML files found inside the archive'],
    };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Force certain elements to always be arrays so single-child cases don't
    // collapse into objects (which would break the recursive walker).
    isArray: (name) => name === 'GroupRange' || name === 'GroupAddress',
  });

  const collected = new Map<number, KnxprojGroupAddress>();
  const warnings: string[] = [];
  let projectName: string | null = null;

  for (const xmlEntry of xmlEntries) {
    let xmlText: string;
    try {
      xmlText = xmlEntry.getData().toString('utf8');
    } catch {
      warnings.push(`Could not read entry ${xmlEntry.entryName}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parser.parse(xmlText);
    } catch (err) {
      warnings.push(
        `Could not parse XML ${xmlEntry.entryName}: ${(err as Error).message}`,
      );
      continue;
    }

    if (projectName === null) {
      projectName = extractProjectName(parsed);
    }
    walkForGroupAddresses(parsed, (ga) => {
      collected.set(ga.raw, ga);
    });
  }

  const groupAddresses = [...collected.values()].sort((a, b) => a.raw - b.raw);
  if (groupAddresses.length === 0) {
    warnings.push('No <GroupAddress> elements found — is this a complete project export?');
  }
  return { groupAddresses, projectName, warnings };
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

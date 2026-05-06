// Tolerant CSV parser for ETS group-address exports.
//
// Real-world variations to handle:
//  - Delimiter: ',' (default), ';' (German locale), or tab
//  - BOM at start of file
//  - Quoted fields with embedded delimiters or doubled quotes
//  - Header column names differ by ETS language (English/German/etc.)
//  - Some exports omit the header row entirely (semicolon/tab variants)
//  - The standard ETS hierarchical 9-column layout:
//      Main, Middle, Sub, Address, Central, Unfiltered, Description,
//      DatapointType, Security
//    Parent rows have placeholder addresses like "1/-/-" or "1/0/-" — we skip
//    these silently because they're not real group addresses.

export interface ParsedRow {
  ga: string;
  dpt: string | null;
  name: string;
  description: string;
}

interface HeaderMap {
  ga: number;
  dpt: number | null;
  /**
   * Column indices to scan in order (typically deepest-first) for a non-empty
   * name. ETS hierarchical exports populate one of Main/Middle/Sub per row,
   * so we walk Sub → Middle → Main and use the first non-empty value.
   */
  nameSearch: number[];
  description: number | null;
}

/** Common header tokens, lower-cased. Add more languages as we encounter them. */
const HEADER_PATTERNS = {
  ga: ['address', 'group address', 'ga', 'adresse', 'gruppenadresse'],
  dpt: ['datapointtype', 'datapoint type', 'dpt', 'datapunkttyp', 'data type'],
  name: ['name', 'libelle', 'libellé'],
  description: ['description', 'beschreibung', 'comment', 'kommentar'],
  // ETS hierarchy columns
  main: ['main'],
  middle: ['middle'],
  sub: ['sub'],
} as const;

const GA_RE_LONG = /^\d{1,2}\/\d{1,2}\/\d{1,4}$/;
const GA_RE_SHORT = /^\d{1,2}\/\d{1,4}$/;
const GA_RE_FREE = /^\d{1,5}$/;

function looksLikeGroupAddress(s: string): boolean {
  return GA_RE_LONG.test(s) || GA_RE_SHORT.test(s) || GA_RE_FREE.test(s);
}

/** Parent/middle pseudo-GAs ETS emits like "1/-/-" or "1/0/-". */
function looksLikeParentPseudoGA(s: string): boolean {
  return /\//.test(s) && /(?:^|\/)-(?:\/|$)/.test(s);
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Pick the delimiter by counting candidates in the first non-empty line. */
function detectDelimiter(firstLine: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuote = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i]!;
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  let best = ',';
  let bestCount = -1;
  for (const [d, c] of Object.entries(counts)) {
    if (c > bestCount) {
      bestCount = c;
      best = d;
    }
  }
  return bestCount > 0 ? best : ',';
}

/** Parse one CSV row into a list of fields. RFC 4180-ish, lenient. */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        buf += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delimiter) {
      fields.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  fields.push(buf);
  return fields.map((f) => f.trim());
}

function findColumn(headers: string[], candidates: readonly string[]): number | null {
  const lowered = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lowered.indexOf(cand);
    if (i !== -1) return i;
  }
  for (const cand of candidates) {
    const i = lowered.findIndex((h) => h.includes(cand));
    if (i !== -1) return i;
  }
  return null;
}

function classifyHeaders(headers: string[]): HeaderMap | null {
  const ga = findColumn(headers, HEADER_PATTERNS.ga);
  if (ga === null) return null;

  const dpt = findColumn(headers, HEADER_PATTERNS.dpt);
  const description = findColumn(headers, HEADER_PATTERNS.description);
  const nameCol = findColumn(headers, HEADER_PATTERNS.name);

  // ETS hierarchical export — Main/Middle/Sub trio
  const main = findColumn(headers, HEADER_PATTERNS.main);
  const middle = findColumn(headers, HEADER_PATTERNS.middle);
  const sub = findColumn(headers, HEADER_PATTERNS.sub);

  const nameSearch: number[] = [];
  if (sub !== null) nameSearch.push(sub);
  if (middle !== null) nameSearch.push(middle);
  if (main !== null) nameSearch.push(main);
  if (nameSearch.length === 0 && nameCol !== null) nameSearch.push(nameCol);

  return { ga, dpt, nameSearch, description };
}

/**
 * Best-effort positional fallback when no header row is found.
 *
 * Recognises the standard ETS hierarchical 9-column layout up-front (cols
 * 0/1/2 = Main/Middle/Sub, col 3 = Address, col 7 = DatapointType, col 6 =
 * Description). Falls back to a generic "find a column whose values look like
 * GAs" scan otherwise.
 */
function classifyByPosition(rows: string[][]): HeaderMap | null {
  if (rows.length === 0) return null;

  // Specific shape: 9-column ETS hierarchical export
  const sampleEts = rows.slice(0, Math.min(rows.length, 30));
  const looksEts =
    sampleEts.every((r) => r.length === 9) &&
    sampleEts.some((r) => {
      const v = (r[3] ?? '').trim();
      return looksLikeGroupAddress(v) || looksLikeParentPseudoGA(v);
    }) &&
    !sampleEts.some((r) => {
      const v = (r[3] ?? '').trim();
      return v !== '' && !looksLikeGroupAddress(v) && !looksLikeParentPseudoGA(v);
    });

  if (looksEts) {
    return { ga: 3, dpt: 7, nameSearch: [2, 1, 0], description: 6 };
  }

  // Generic fallback — find any column where the bulk of values look like GAs.
  const sample = rows.slice(0, 10);
  const colCount = Math.max(...sample.map((r) => r.length));
  for (let col = 0; col < colCount; col++) {
    const values = sample.map((r) => (r[col] ?? '').trim()).filter((v) => v !== '');
    if (values.length === 0) continue;
    const matchCount = values.filter(
      (v) => looksLikeGroupAddress(v) || looksLikeParentPseudoGA(v),
    ).length;
    if (matchCount / values.length >= 0.8) {
      const dptCandidate = col + 1;
      return {
        ga: col,
        dpt: dptCandidate < colCount ? dptCandidate : null,
        nameSearch: col > 0 ? [col - 1] : [],
        description: null,
      };
    }
  }
  return null;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
}

/** Parse an ETS CSV export. Auto-detects delimiter and header layout. */
export function parseEtsCsv(input: string): ParseResult {
  const text = stripBOM(input);
  if (!text.trim()) return { rows: [], warnings: ['CSV is empty'] };

  const lines = text.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim() !== '') ?? '';
  const delimiter = detectDelimiter(firstNonEmpty);

  const rawRows = lines
    .filter((l) => l.trim() !== '')
    .map((l) => parseCsvLine(l, delimiter));

  if (rawRows.length === 0) return { rows: [], warnings: ['CSV had no parseable rows'] };

  const warnings: string[] = [];
  let headerMap: HeaderMap | null = null;
  let dataStart = 0;

  const headerCandidate = rawRows[0]!;
  headerMap = classifyHeaders(headerCandidate);
  if (headerMap) {
    dataStart = 1;
  } else {
    headerMap = classifyByPosition(rawRows);
    if (!headerMap) {
      warnings.push(
        'Could not identify a Group Address column. Expected a header row containing "Address" / "Group address" / "Adresse", or a recognisable layout (e.g. ETS 9-column hierarchical export).',
      );
      return { rows: [], warnings };
    }
  }

  const out: ParsedRow[] = [];
  for (let i = dataStart; i < rawRows.length; i++) {
    const row = rawRows[i]!;
    const ga = (row[headerMap.ga] ?? '').trim();
    if (!ga) continue;
    if (looksLikeParentPseudoGA(ga)) continue; // hierarchical placeholder — skip silently
    if (!looksLikeGroupAddress(ga)) {
      warnings.push(`Row ${i + 1}: skipped — "${ga}" is not a valid group address`);
      continue;
    }

    let name = '';
    for (const idx of headerMap.nameSearch) {
      const v = (row[idx] ?? '').trim();
      if (v) {
        name = v;
        break;
      }
    }
    const description =
      headerMap.description !== null ? (row[headerMap.description] ?? '').trim() : '';
    out.push({
      ga,
      dpt: headerMap.dpt !== null ? (row[headerMap.dpt] ?? '').trim() || null : null,
      // Backfill: when only Description carries text and there's no leaf name
      // column, use Description for the display name too.
      name: name || description,
      description,
    });
  }

  if (out.length === 0) warnings.push('No group-address rows extracted');
  return { rows: out, warnings };
}

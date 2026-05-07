// Tiny zero-dependency cron expression matcher.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Supports a 5-field expression: minute hour day-of-month month day-of-week.
// Each field accepts:
//   - "*"             — any value
//   - "N"             — single literal
//   - "A-B"           — range (inclusive)
//   - "A/N" or "*/N"  — step
//   - "A,B,C"         — list (combinable: "1,5-10/2,15-20")
//
// Days-of-week use 0–6 with 0 = Sunday (the cron convention used by Node-RED's
// own schedule pickers and most Linux crons). 7 is also accepted as Sunday for
// compatibility with crontab(5).
//
// We intentionally do not implement the @yearly / @monthly aliases, the W/L/#
// quartz extensions, or named months. Keep it small; users wanting more reach
// for `node-red-contrib-cron-plus`.

export interface CronMatcher {
  /** Returns true when the given Date falls inside this cron schedule. */
  matches(date: Date): boolean;
  /** Original expression — used for status messages. */
  readonly expression: string;
}

interface Field {
  /** Sorted list of accepted integer values within the field's natural range. */
  values: Set<number>;
}

const RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

function expandPiece(
  piece: string,
  min: number,
  max: number,
  fieldName: string,
): number[] {
  // "*/N" → step over the whole range; "A/N" or "A-B/N" → step within a range.
  let stepNum = 1;
  let body = piece;
  const slash = piece.indexOf('/');
  if (slash !== -1) {
    body = piece.slice(0, slash);
    const stepStr = piece.slice(slash + 1);
    stepNum = Number.parseInt(stepStr, 10);
    if (!Number.isInteger(stepNum) || stepNum <= 0) {
      throw new Error(`cron ${fieldName}: invalid step "${stepStr}"`);
    }
  }

  let lo: number;
  let hi: number;
  if (body === '*' || body === '') {
    lo = min;
    hi = max;
  } else if (body.indexOf('-') !== -1) {
    const [a, b] = body.split('-');
    lo = Number.parseInt(a!, 10);
    hi = Number.parseInt(b!, 10);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`cron ${fieldName}: invalid range "${body}"`);
    }
  } else {
    lo = Number.parseInt(body, 10);
    hi = lo;
    if (!Number.isInteger(lo)) {
      throw new Error(`cron ${fieldName}: invalid value "${body}"`);
    }
  }

  if (lo < min || hi > max || lo > hi) {
    throw new Error(`cron ${fieldName}: ${body} out of range ${min}..${max}`);
  }

  const out: number[] = [];
  for (let v = lo; v <= hi; v += stepNum) out.push(v);
  return out;
}

function parseField(raw: string, min: number, max: number, fieldName: string): Field {
  const values = new Set<number>();
  for (const piece of raw.split(',')) {
    const cleaned = piece.trim();
    if (!cleaned) throw new Error(`cron ${fieldName}: empty piece`);
    for (const v of expandPiece(cleaned, min, max, fieldName)) {
      values.add(v);
    }
  }
  return { values };
}

/**
 * Compile a 5-field cron expression. Throws on malformed input.
 * Returns a matcher whose `matches(date)` is O(1) per call.
 */
export function compileCron(expression: string): CronMatcher {
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  const parts = trimmed.split(' ');
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (minute hour dom month dow), got "${expression}"`,
    );
  }

  // Day-of-week: accept 7 as alias for 0 (Sunday) per crontab(5).
  const dowRaw = parts[4]!.replace(/(?<![\d-])7(?![\d-])/g, '0');

  const fields: Field[] = [];
  for (let i = 0; i < 5; i++) {
    const raw = i === 4 ? dowRaw : parts[i]!;
    const { name, min, max } = RANGES[i]!;
    fields.push(parseField(raw, min, max, name));
  }
  const [minF, hourF, domF, monthF, dowF] = fields as [Field, Field, Field, Field, Field];

  return {
    expression,
    matches(date: Date): boolean {
      // Match in local time — that's what humans setting "every day at 7am"
      // mean, and what Node-RED's own schedule UIs assume.
      if (!minF.values.has(date.getMinutes())) return false;
      if (!hourF.values.has(date.getHours())) return false;
      if (!monthF.values.has(date.getMonth() + 1)) return false;
      // Vixie-cron rule: when both dom and dow are restricted (i.e., not "*"),
      // OR them together. When only one is restricted, AND it.
      const domMatch = domF.values.has(date.getDate());
      const dowMatch = dowF.values.has(date.getDay());
      const domRestricted = domF.values.size !== RANGES[2]!.max;
      const dowRestricted = dowF.values.size !== RANGES[4]!.max + 1;
      if (domRestricted && dowRestricted) {
        return domMatch || dowMatch;
      }
      return domMatch && dowMatch;
    },
  };
}

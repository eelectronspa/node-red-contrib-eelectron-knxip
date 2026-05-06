// Group-address matchers. Supports exact GA strings (`1/2/3`, `1/123`, `1234`)
// and wildcard patterns in long form (`1/2/*`, `1/*/3`, `*/*/*`).
//
// Patterns are decomposed against the long-form bit layout of the raw uint16:
//   main   = (raw >> 11) & 0x1f  (5 bits, 0..31)
//   middle = (raw >> 8)  & 0x07  (3 bits, 0..7)
//   sub    =  raw        & 0xff  (8 bits, 0..255)

import { GroupAddress, type GroupAddressStyle } from './address';

export type GAMatcher = (raw: number) => boolean;

const SEGMENT_LIMITS = [31, 7, 255] as const;
const SEGMENT_NAMES = ['main', 'middle', 'sub'] as const;

/**
 * Compile a pattern into a fast predicate over raw uint16 GAs.
 *
 * Wildcard patterns must be in long form (3 segments, each a number or `*`).
 * Exact patterns can use any GroupAddress notation (long/short/free).
 */
export function compileGAPattern(
  pattern: string,
  defaultStyle: GroupAddressStyle = 'long',
): GAMatcher {
  if (!pattern.includes('*')) {
    const ga = new GroupAddress(pattern, defaultStyle);
    const target = ga.raw;
    return (raw) => raw === target;
  }

  const parts = pattern.split('/');
  if (parts.length !== 3) {
    throw new Error(
      `GA wildcard pattern must have 3 segments (main/middle/sub): "${pattern}"`,
    );
  }

  const expected: (number | null)[] = parts.map((part, idx) => {
    const trimmed = part.trim();
    if (trimmed === '*') return null;
    const n = Number.parseInt(trimmed, 10);
    const max = SEGMENT_LIMITS[idx]!;
    if (!Number.isFinite(n) || n < 0 || n > max) {
      throw new Error(
        `Invalid ${SEGMENT_NAMES[idx]} segment "${part}" in "${pattern}" (must be 0..${max} or *)`,
      );
    }
    return n;
  });

  const [mainExp, middleExp, subExp] = expected;
  return (raw) => {
    const main = (raw >> 11) & 0x1f;
    const middle = (raw >> 8) & 0x07;
    const sub = raw & 0xff;
    if (mainExp !== null && main !== mainExp) return false;
    if (middleExp !== null && middle !== middleExp) return false;
    if (subExp !== null && sub !== subExp) return false;
    return true;
  };
}

/** Compile a list of patterns into a single any-match predicate. */
export function compileGAPatterns(
  patterns: string[],
  defaultStyle: GroupAddressStyle = 'long',
): GAMatcher | null {
  if (patterns.length === 0) return null;
  const matchers = patterns.map((p) => compileGAPattern(p, defaultStyle));
  return (raw) => matchers.some((m) => m(raw));
}

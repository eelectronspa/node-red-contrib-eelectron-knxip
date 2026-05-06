// Normalize the many DPT id strings that ETS exports into the form our codec
// registry uses ("M.SSS").
//
// Common shapes:
//   DPST-1-1     -> 1.001    (ETS5/ETS6 standard for sub-types)
//   DPST-9-7     -> 9.007
//   DPT-1        -> 1        (no sub-type information)
//   DPT-9.001    -> 9.001
//   DPT-1.001    -> 1.001
//   1.001        -> 1.001
//   1            -> 1
//   ''/null      -> null

import { hasDpt, listDpts } from '../dpt';

export interface NormalizedDpt {
  /** Canonical id like "1.001" or just "1" if no sub. */
  id: string;
  /** Main number (1, 5, 9, ...). */
  main: number;
  /** Sub number, or null if not present. */
  sub: number | null;
  /** True iff our codec library can encode/decode this id. */
  registered: boolean;
}

const DPST_RE = /^DPST-(\d+)-(\d+)$/i;
const DPT_DASH_RE = /^DPT-(\d+)(?:[.-](\d+))?$/i;
const PLAIN_RE = /^(\d+)(?:\.(\d+))?$/;

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}

export function normalizeDptId(input: string | null | undefined): NormalizedDpt | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let main: number | null = null;
  let sub: number | null = null;

  const dpst = DPST_RE.exec(trimmed);
  if (dpst) {
    main = Number.parseInt(dpst[1]!, 10);
    sub = Number.parseInt(dpst[2]!, 10);
  } else {
    const dash = DPT_DASH_RE.exec(trimmed);
    if (dash) {
      main = Number.parseInt(dash[1]!, 10);
      if (dash[2]) sub = Number.parseInt(dash[2], 10);
    } else {
      const plain = PLAIN_RE.exec(trimmed);
      if (plain) {
        main = Number.parseInt(plain[1]!, 10);
        if (plain[2]) sub = Number.parseInt(plain[2], 10);
      }
    }
  }

  if (main === null || Number.isNaN(main)) return null;

  let id = sub !== null ? `${main}.${pad3(sub)}` : `${main}`;
  let registered = hasDpt(id);

  // ETS exports sometimes carry only the main number (e.g. "DPT-7"). The bare
  // main id is never registered — every codec registers a specific sub. Fall
  // back to N.001 if that exists, otherwise pick the first registered N.* so
  // the listener/translator can still operate.
  if (!registered && sub === null) {
    const fallback = findFallbackSub(main);
    if (fallback) {
      id = fallback;
      registered = true;
    }
  }

  return { id, main, sub, registered };
}

function findFallbackSub(main: number): string | null {
  const preferred = `${main}.001`;
  if (hasDpt(preferred)) return preferred;
  const prefix = `${main}.`;
  const match = listDpts().find((id) => id.startsWith(prefix));
  return match ?? null;
}

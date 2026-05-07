// Tiny brace-placeholder template engine used by the mqtt-publish node.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Two surfaces:
//   - `interpolateString(template, ctx)` — replaces every `{key}` with the
//     stringified context value. Used for topics and string-embedded payload
//     fields.
//   - `renderJsonTemplate(jsonTemplate, ctx)` — parses a JSON template, then
//     walks the tree replacing string values:
//       * If the string is *exactly* `"{key}"` → swap in the typed JS value
//         from the context (preserves number/bool/object/null types).
//       * Otherwise → string interpolation (string concat with the
//         placeholder replaced by the stringified value).
//
// This is the trick MQTT bridge templates everywhere use to let users keep
// types intact while still typing JSON-shaped templates.

export type TemplateCtx = Record<string, unknown>;

export function interpolateString(template: string, ctx: TemplateCtx): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      const v = ctx[key];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        return String(v);
      }
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    // Unknown placeholder: leave the literal text. Lets users type
    // legitimate { } in topics if they keep the placeholder name unknown.
    return match;
  });
}

/**
 * Walk an already-parsed JSON template object and substitute placeholders
 * in every string leaf. Returns a fresh object — does not mutate the input.
 */
export function renderJsonValue(value: unknown, ctx: TemplateCtx): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => renderJsonValue(item, ctx));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderJsonValue(v, ctx);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  // Pure-placeholder shorthand: "{key}" replaces with the typed value.
  const pure = /^\{([a-zA-Z0-9_]+)\}$/.exec(value);
  if (pure) {
    const key = pure[1]!;
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key];
    return value; // unknown placeholder — keep literal
  }
  return interpolateString(value, ctx);
}

export interface RenderResult {
  ok: boolean;
  /** When `ok=false`, why parsing/rendering failed. */
  error?: string;
  value?: unknown;
}

/** Parse + render a JSON template in one step. Surfaces parse errors. */
export function renderJsonTemplate(jsonTemplate: string, ctx: TemplateCtx): RenderResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonTemplate);
  } catch (err) {
    return { ok: false, error: `JSON template did not parse: ${(err as Error).message}` };
  }
  try {
    return { ok: true, value: renderJsonValue(parsed, ctx) };
  } catch (err) {
    return { ok: false, error: `Render failed: ${(err as Error).message}` };
  }
}

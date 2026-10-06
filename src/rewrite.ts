import type { HtmlRef } from "./htmlRefs.ts";

/**
 * Replaces the attribute values located by `refs` with the supplied new
 * values (already resolved against package layout). `refs` must be in
 * document order; `replacements[i]` corresponds to `refs[i]` and is the
 * plain (unescaped) value, which is escaped here for safe embedding. A
 * null replacement keeps the original raw value.
 */
export function rewriteHtml(
  html: string,
  refs: HtmlRef[],
  replacements: (string | null)[],
): string {
  let out = "";
  let cursor = 0;
  for (let i = 0; i < refs.length; i++) {
    const replacement = replacements[i];
    if (replacement === null || replacement === undefined) continue;
    const ref = refs[i];
    out += html.slice(cursor, ref.valueStart);
    out += escapeHtmlAttr(replacement);
    cursor = ref.valueEnd;
  }
  out += html.slice(cursor);
  return out;
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

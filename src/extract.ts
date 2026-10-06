import type { ExtractResult, FieldRule } from "./types";
import { normalizePage, toOriginalSpan } from "./normalize";
import type { FieldCandidate } from "./types";

/**
 * Re-flag the user pattern for Unicode global matching with capture
 * indices. The pattern source itself is never rewritten. Sticky mode
 * is dropped because matching must scan each region globally.
 */
function toGlobalUnicode(pattern: RegExp): RegExp {
  let flags = pattern.flags.replace("y", "");
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("u") && !flags.includes("v")) flags += "u";
  if (!flags.includes("d")) flags += "d";
  return new RegExp(pattern.source, flags);
}

/** Non-overlapping occurrences of a literal keyword, left to right. */
function findAnchors(text: string, anchor: string): { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= text.length - anchor.length) {
    const at = text.indexOf(anchor, from);
    if (at < 0) break;
    hits.push({ start: at, end: at + anchor.length });
    from = at + anchor.length;
  }
  return hits;
}

/**
 * Extract field candidates from raw page texts according to the rules.
 * Everything lives in memory; nothing is persisted.
 */
export function extractFields(pages: string[], rules: FieldRule[]): ExtractResult {
  const normalizedPages = pages.map(normalizePage);
  const candidates: FieldCandidate[] = [];

  const prepared = rules.map((rule) => {
    const anchor = normalizePage(rule.anchor).text;
    if (anchor.length === 0) {
      throw new Error(`field "${rule.name}": anchor normalizes to an empty string`);
    }
    if (!rule.pattern.source.includes("(?<value>")) {
      throw new Error(`field "${rule.name}": pattern must define a named capture group "value"`);
    }
    return { rule, anchor, regex: toGlobalUnicode(rule.pattern) };
  });

  normalizedPages.forEach((page, pageIndex) => {
    for (const { rule, anchor, regex } of prepared) {
      const anchors = findAnchors(page.text, anchor);
      for (let i = 0; i < anchors.length; i += 1) {
        const regionStart = anchors[i].end;
        const regionEnd = i + 1 < anchors.length ? anchors[i + 1].start : page.text.length;
        const regionText = page.text.slice(regionStart, regionEnd);
        const anchorSpan = toOriginalSpan(page, anchors[i].start, anchors[i].end);

        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(regionText)) !== null) {
          const value = match.groups?.value;
          const valueIndex = match.indices?.groups?.value;
          if (value !== undefined && value.length > 0 && valueIndex !== undefined) {
            candidates.push({
              field: rule.name,
              value,
              page: pageIndex,
              anchor: anchorSpan,
              valueSpan: toOriginalSpan(
                page,
                regionStart + valueIndex[0],
                regionStart + valueIndex[1],
              ),
            });
          }
          if (match[0].length === 0) {
            // Zero-length match: at most one candidate per code point
            // boundary; advance one full code point (never splitting a
            // surrogate pair) and keep searching.
            const at = regex.lastIndex;
            if (at >= regionText.length) break;
            const codePoint = regionText.codePointAt(at) as number;
            regex.lastIndex = at + (codePoint > 0xffff ? 2 : 1);
          }
        }
      }
    }
  });

  return { pages: normalizedPages.map((p) => p.text), candidates };
}

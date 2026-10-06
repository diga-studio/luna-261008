import { evidenceSpan, normalizeAnchor, normalizePage } from "./normalize";
import type { FieldCandidate, FieldRule } from "./types";

/**
 * Extracts field candidates from per-page raw text. Everything lives in
 * memory: pages and rules go in, candidates with original-text evidence
 * spans come out. Pages are never concatenated.
 */
export function extractFields(
  pages: string[],
  rules: FieldRule[],
): FieldCandidate[] {
  const prepared = rules.map((rule) => {
    const anchor = normalizeAnchor(rule.anchor);
    if (anchor.length === 0) {
      throw new Error(`Rule "${rule.name}": anchor is empty after normalization`);
    }
    if (!/\(\?<value[>=]/.test(rule.pattern.source)) {
      throw new Error(`Rule "${rule.name}": pattern must contain a "(?<value>...)" group`);
    }
    // Unicode + global + hasIndices matching; the pattern source is used
    // verbatim, only flags are normalized.
    const flags = new Set(rule.pattern.flags.split(""));
    flags.add("g");
    flags.add("u");
    flags.add("d");
    const pattern = new RegExp(rule.pattern.source, [...flags].join(""));
    return { rule, anchor, pattern };
  });

  const normalizedPages = pages.map((page) => normalizePage(page));
  const candidates: FieldCandidate[] = [];

  for (const { rule, anchor, pattern } of prepared) {
    for (let page = 0; page < normalizedPages.length; page++) {
      const norm = normalizedPages[page];

      // Anchor occurrences: left to right, non-overlapping.
      const anchors: Array<{ start: number; end: number }> = [];
      let from = 0;
      while (from <= norm.text.length) {
        const at = norm.text.indexOf(anchor, from);
        if (at === -1) break;
        anchors.push({ start: at, end: at + anchor.length });
        from = at + anchor.length;
      }

      for (let i = 0; i < anchors.length; i++) {
        const regionStart = anchors[i].end;
        const regionEnd =
          i + 1 < anchors.length ? anchors[i + 1].start : norm.text.length;
        const regionText = norm.text.slice(regionStart, regionEnd);

        // matchAll advances lastIndex past a full code point after an empty
        // match, so one boundary yields at most one candidate and surrogate
        // pairs are never split.
        for (const match of regionText.matchAll(pattern)) {
          const value = match.groups?.value;
          const groupSpan = match.indices?.groups?.value;
          if (value === undefined || groupSpan === undefined) continue;
          if (value.length === 0) continue;
          candidates.push({
            field: rule.name,
            value,
            page,
            anchorSpan: evidenceSpan(norm, anchors[i].start, anchors[i].end),
            valueSpan: evidenceSpan(
              norm,
              regionStart + groupSpan[0],
              regionStart + groupSpan[1],
            ),
          });
        }
      }
    }
  }

  return candidates;
}

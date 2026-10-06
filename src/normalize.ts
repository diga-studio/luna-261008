import type { EvidenceSpan } from "./types";

/** Per-UTF-16-code-unit mapping from normalized text back to original offsets. */
export interface NormalizedText {
  text: string;
  /** map[i] = original [start, end) range contributing to normalized unit i. */
  map: Array<{ start: number; end: number }>;
}

const SOFT_HYPHEN = "\u00AD";
const WHITE_SPACE = /\p{White_Space}/u;

/**
 * Normalizes one page: NFKC, remove U+00AD, collapse each White_Space run
 * into a single ASCII space (leading/trailing collapsed spaces are kept).
 * Records, for every UTF-16 code unit of the result, the original range of
 * the grapheme cluster(s) that contributed to it.
 */
export function normalizePage(_raw: string): NormalizedText {
  // Pass 1: NFKC per extended grapheme cluster. Cluster boundaries are
  // normalization-stable for composition (combining marks stay inside the
  // cluster), so per-cluster NFKC equals whole-string NFKC while letting us
  // attribute every output unit to exactly one original cluster.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let stage = "";
  const stageMap: Array<{ start: number; end: number }> = [];
  for (const { segment, index } of segmenter.segment(_raw)) {
    const normalized = segment.normalize("NFKC");
    for (let i = 0; i < normalized.length; i++) {
      stageMap.push({ start: index, end: index + segment.length });
    }
    stage += normalized;
  }

  // Pass 2: delete soft hyphens; they contribute nothing to the output.
  let joined = "";
  const joinedMap: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < stage.length; i++) {
    if (stage[i] === SOFT_HYPHEN) continue;
    joined += stage[i];
    joinedMap.push(stageMap[i]);
  }

  // Pass 3: collapse each White_Space run into one ASCII space whose
  // contributing range covers the whole original run.
  let text = "";
  const map: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < joined.length) {
    const ch = joined[i];
    if (!WHITE_SPACE.test(ch)) {
      text += ch;
      map.push(joinedMap[i]);
      i++;
      continue;
    }
    const start = joinedMap[i].start;
    let end = joinedMap[i].end;
    i++;
    while (i < joined.length && WHITE_SPACE.test(joined[i])) {
      end = joinedMap[i].end;
      i++;
    }
    text += " ";
    map.push({ start, end });
  }

  return { text, map };
}

/** Anchors go through the exact same pipeline as page text. */
export function normalizeAnchor(anchor: string): string {
  return normalizePage(anchor).text;
}

/**
 * Maps a half-open range of the normalized text to the minimal contiguous
 * original-text interval covering all contributing characters. Because
 * contributions are tracked per grapheme cluster, the result always contains
 * the full clusters involved; deleted soft hyphens are only included when
 * they fall inside that interval.
 */
export function evidenceSpan(
  norm: NormalizedText,
  start: number,
  end: number,
): EvidenceSpan {
  if (start >= end) {
    const at =
      start < norm.map.length
        ? norm.map[start].start
        : norm.map.length > 0
          ? norm.map[norm.map.length - 1].end
          : 0;
    return { start: at, end: at };
  }
  return { start: norm.map[start].start, end: norm.map[end - 1].end };
}

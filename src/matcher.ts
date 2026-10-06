import type { SourceRange } from './types.js';
import type { NormalizedSegment } from './normalize.js';
import type { InternalLexicon } from './lexicon.js';

/** Raw match inside one segment: normalized span plus lexicon entry index. */
export interface RawMatch {
  entryIndex: number;
  /** Start offset (UTF-16) inside the segment's normalized text. */
  start: number;
  /** End offset (UTF-16, exclusive) inside the segment's normalized text. */
  end: number;
}

interface AcNode {
  next: Map<string, AcNode>;
  fail: AcNode | null;
  /** Lexicon entry indices (into InternalLexicon.normalized) ending here. */
  outputs: number[];
}

/** A reusable multi-pattern matcher for one lexicon. */
export interface Matcher {
  root: AcNode;
  lexicon: InternalLexicon;
}

/** Build an Aho-Corasick automaton over the lexicon's normalized words. */
export function buildMatcher(lexicon: InternalLexicon): Matcher {
  const root: AcNode = { next: new Map(), fail: null, outputs: [] };
  lexicon.normalized.forEach((pattern, index) => {
    let node = root;
    for (let k = 0; k < pattern.length; k++) {
      const unit = pattern[k];
      let child = node.next.get(unit);
      if (child === undefined) {
        child = { next: new Map(), fail: null, outputs: [] };
        node.next.set(unit, child);
      }
      node = child;
    }
    node.outputs.push(index);
  });
  // BFS failure links; outputs are merged along failure chains so that
  // shorter words ending inside longer ones are also reported.
  const queue: AcNode[] = [];
  for (const child of root.next.values()) {
    child.fail = root;
    queue.push(child);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const [unit, child] of node.next) {
      let fallback = node.fail!;
      while (fallback !== root && !fallback.next.has(unit)) fallback = fallback.fail!;
      child.fail = fallback.next.get(unit) ?? root;
      if (child.fail === child) child.fail = root;
      child.outputs.push(...child.fail.outputs);
      queue.push(child);
    }
  }
  return { root, lexicon };
}

/** Find all occurrences of all lexicon words inside one segment. */
export function matchSegment(
  segment: NormalizedSegment,
  matcher: Matcher,
): RawMatch[] {
  const { root, lexicon } = matcher;
  const matches: RawMatch[] = [];
  let node = root;
  for (let i = 0; i < segment.text.length; i++) {
    const unit = segment.text[i];
    while (node !== root && !node.next.has(unit)) node = node.fail!;
    node = node.next.get(unit) ?? root;
    for (const patternIndex of node.outputs) {
      matches.push({
        entryIndex: lexicon.entryIndex[patternIndex],
        start: i + 1 - lexicon.normalized[patternIndex].length,
        end: i + 1,
      });
    }
  }
  return matches;
}

/** Merge overlapping or adjacent ranges; input may be unsorted. */
export function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

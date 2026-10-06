import type { Lexicon, MatchHit, SourceRange } from './types.js';
import { buildLexicon, type InternalLexicon } from './lexicon.js';
import { extractSegments } from './markdown.js';
import { normalizeSegment } from './normalize.js';
import { buildMatcher, matchSegment, mergeRanges } from './matcher.js';

export type { Lexicon, MatchHit, SourceRange } from './types.js';
export { loadLexicon } from './lexicon.js';

function asInternal(lexicon: Lexicon): InternalLexicon {
  const candidate = lexicon as Partial<InternalLexicon>;
  if (Array.isArray(candidate.normalized) && Array.isArray(candidate.entryIndex)) {
    return candidate as InternalLexicon;
  }
  return buildLexicon(lexicon.words);
}

/**
 * Check Markdown content against a loaded lexicon.
 *
 * Returns every hit: overlapping words and repeated occurrences are all
 * reported, and hits are never deduplicated away. Positions are half-open
 * UTF-16 ranges over the original source.
 */
export function checkContent(lexicon: Lexicon, content: string): MatchHit[] {
  const internal = asInternal(lexicon);
  const matcher = buildMatcher(internal);
  const hits: MatchHit[] = [];
  for (const chars of extractSegments(content)) {
    const segment = normalizeSegment(chars);
    for (const match of matchSegment(segment, matcher)) {
      const ranges: SourceRange[] = [];
      let lastCluster = -1;
      for (let i = match.start; i < match.end; i++) {
        const cluster = segment.clusterAt[i];
        if (cluster === lastCluster) continue;
        lastCluster = cluster;
        ranges.push(...segment.clusters[cluster].ranges);
      }
      hits.push({
        word: internal.words[match.entryIndex],
        ranges: mergeRanges(ranges),
      });
    }
  }
  return hits;
}

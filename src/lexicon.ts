import { readFileSync } from 'node:fs';
import type { Lexicon } from './types.js';
import { normalizeWord } from './normalize.js';

/** Internal lexicon representation: original words plus normalized forms. */
export interface InternalLexicon extends Lexicon {
  /** Normalized word per kept entry (entries normalizing to "" are dropped). */
  readonly normalized: readonly string[];
  /** Index into `words` for each entry of `normalized`. */
  readonly entryIndex: readonly number[];
}

/**
 * Load a lexicon from a local text file: one word per line, blank lines
 * skipped, duplicate entries removed. Entries are plain text (never parsed
 * as Markdown) and are normalized with the same rules as content.
 */
export function loadLexicon(filePath: string): Lexicon {
  const raw = readFileSync(filePath, 'utf8');
  const words: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const word = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (word === '' || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return buildLexicon(words);
}

/** Build the internal lexicon from raw word entries. */
export function buildLexicon(words: readonly string[]): InternalLexicon {
  const normalized: string[] = [];
  const entryIndex: number[] = [];
  words.forEach((word, i) => {
    const n = normalizeWord(word);
    if (n === '') return;
    normalized.push(n);
    entryIndex.push(i);
  });
  return { words, normalized, entryIndex };
}

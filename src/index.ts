import type { PhraseEntry, PhraseTable } from "./types.ts";
import { buildAutomaton } from "./automaton.ts";

export type { PhraseEntry, PhraseTable } from "./types.ts";
export { translate } from "./translate.ts";

/**
 * Compiles a phrase table for repeated use by `translate`.
 * Entries must have non-empty source/target and unique sources.
 * Time and space: O(M), M = total source+target length in code points.
 */
export function compile(entries: readonly PhraseEntry[]): PhraseTable {
  let maxSourceLength = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.source.length === 0 || entry.target.length === 0) {
      throw new Error("phrase entries must have non-empty source and target");
    }
    if (seen.has(entry.source)) {
      throw new Error(`duplicate source: ${JSON.stringify(entry.source)}`);
    }
    seen.add(entry.source);
    const length = Array.from(entry.source).length;
    if (length > maxSourceLength) maxSourceLength = length;
  }
  return {
    maxSourceLength,
    size: entries.length,
    automaton: buildAutomaton(entries),
  };
}

import { Rule, Scanner, ScanResult } from "./types";
import { KeywordMatcher, MatcherState } from "./matcher";
import { MimeParser } from "./mime";

const QUARANTINE_THRESHOLD = 70;
const SCORE_CAP = 100;

export function createScanner(rules: Rule[]): Scanner {
  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (seenIds.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seenIds.add(rule.id);
    if (rule.needle.length === 0) {
      throw new Error(`rule ${rule.id} has empty needle`);
    }
    if (!Number.isInteger(rule.weight) || rule.weight <= 0) {
      throw new Error(`rule ${rule.id} has invalid weight`);
    }
  }

  const matcher = new KeywordMatcher(rules);
  const reported = new Set<string>();
  const weights = new Map<string, number>();
  for (const rule of rules) {
    weights.set(rule.id, rule.weight);
  }

  let leafState: MatcherState | null = null;
  let pendingHits: string[] = [];
  let finished = false;

  const collect = (ids: string[]): void => {
    for (const id of ids) {
      if (!reported.has(id)) {
        reported.add(id);
        pendingHits.push(id);
      }
    }
  };

  const parser = new MimeParser({
    onLeafStart(): void {
      leafState = matcher.createState();
    },
    onLeafText(text: string): void {
      if (leafState !== null) {
        collect(matcher.feed(leafState, text));
      }
    },
    onLeafEnd(): void {
      leafState = null;
    },
  });

  return {
    write(bytes: Uint8Array): string[] {
      if (finished) {
        throw new Error("cannot write after finish");
      }
      parser.write(bytes);
      const hits = pendingHits;
      pendingHits = [];
      return hits;
    },
    finish(): ScanResult {
      if (finished) {
        throw new Error("finish called twice");
      }
      finished = true;
      parser.finish();
      const hitIds = [...reported];
      pendingHits = [];
      let score = 0;
      for (const id of reported) {
        score += weights.get(id)!;
      }
      const capped = Math.min(score, SCORE_CAP);
      return {
        hitIds,
        score: capped,
        quarantined: capped >= QUARANTINE_THRESHOLD,
      };
    },
  };
}

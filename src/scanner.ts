import { KeywordMatcher } from "./matcher.js";
import { MimeParser, type LeafHandler } from "./mime.js";
import { createCharsetDecoder, createTransferDecoder } from "./decode.js";
import type { PartHeaders } from "./headers.js";
import type { Rule, Scanner, ScanResult } from "./types.js";

export type { Rule, ScanResult, Scanner } from "./types.js";

const SCORE_CAP = 100;
const QUARANTINE_THRESHOLD = 70;

function validateRules(rules: Rule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.id !== "string" || rule.id.length === 0) {
      throw new Error("rule id must be a non-empty string");
    }
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
    if (typeof rule.needle !== "string" || rule.needle.length === 0) {
      throw new Error(`rule ${rule.id}: needle must be non-empty`);
    }
    if (!Number.isInteger(rule.weight) || rule.weight <= 0) {
      throw new Error(`rule ${rule.id}: weight must be a positive integer`);
    }
  }
}

/** 创建单封邮件的扫描器。规则非法（id 重复、needle 为空、weight 非正整数）时抛错。 */
export function createScanner(rules: Rule[]): Scanner {
  validateRules(rules);
  const matcher = new KeywordMatcher(rules);
  const weightById = new Map(rules.map((r) => [r.id, r.weight]));

  /** 本次 write() 期间产生的新命中。 */
  let fresh: string[] = [];
  let finished = false;

  const parser = new MimeParser((headers: PartHeaders): LeafHandler | null => {
    if (headers.mediaType !== "text/plain") {
      return null;
    }
    const transfer = createTransferDecoder(headers.transferEncoding);
    const charset = createCharsetDecoder(headers.charset);
    return {
      push(bytes: Uint8Array): void {
        const decoded = transfer.push(bytes);
        const text = charset.push(decoded);
        if (text.length > 0) {
          fresh.push(...matcher.feed(text));
        }
      },
      end(): void {
        const tail = transfer.end();
        const text = charset.push(tail) + charset.end();
        if (text.length > 0) {
          fresh.push(...matcher.feed(text));
        }
      },
    };
  });

  return {
    write(bytes: Uint8Array): string[] {
      if (finished) {
        throw new Error("cannot write after finish");
      }
      fresh = [];
      parser.write(bytes);
      const hits = fresh;
      fresh = [];
      return hits;
    },
    finish(): ScanResult {
      if (finished) {
        throw new Error("finish called twice");
      }
      finished = true;
      parser.finish();
      const hitIds = matcher.hitIds();
      let score = 0;
      for (const id of hitIds) {
        score += weightById.get(id)!;
      }
      score = Math.min(score, SCORE_CAP);
      return { hitIds, score, quarantined: score >= QUARANTINE_THRESHOLD };
    },
  };
}

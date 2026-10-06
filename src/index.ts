import { Lexer } from "./lexer.js";
import { Analyzer } from "./analyzer.js";
import type { AnalysisResult } from "./types.js";

export type { AnalysisResult, AnalysisStatus, Hit, OperationType } from "./types.js";

/**
 * Embeddable detector for destructive SQL operations in one event.
 * Usage: create an instance, push() each byte fragment, then call end().
 * Nothing is retained after end(); raw SQL content is never stored.
 */
export class DestructiveSqlAnalyzer {
  private readonly analyzer = new Analyzer();
  private readonly lexer = new Lexer((token) => this.analyzer.feed(token));

  /** Submit the next UTF-8 byte fragment (1 byte to 64 KiB, any split). */
  push(chunk: Uint8Array): void {
    this.lexer.push(chunk);
  }

  /** Mark the event finished and obtain the verdict. */
  end(): AnalysisResult {
    return this.analyzer.end(this.lexer.end());
  }
}

/** Convenience one-shot analysis of a complete SQL text. */
export function analyze(sql: string | Uint8Array): AnalysisResult {
  const a = new DestructiveSqlAnalyzer();
  a.push(typeof sql === "string" ? new TextEncoder().encode(sql) : sql);
  return a.end();
}

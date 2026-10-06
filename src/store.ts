import type { StageChange } from "./types.js";
import { STAGES } from "./types.js";

const STAGE_SET: ReadonlySet<string> = new Set(STAGES);

function validateRecord(record: StageChange, index: number): void {
  if (record === null || typeof record !== "object") {
    throw new TypeError(`history[${index}] must be an object`);
  }
  if (!Number.isInteger(record.at)) {
    throw new RangeError(`history[${index}].at must be an integer (UTC ms), got ${record.at}`);
  }
  if (!STAGE_SET.has(record.stage)) {
    throw new RangeError(`history[${index}].stage must be one of ${STAGES.join(", ")}, got ${String(record.stage)}`);
  }
}

function validateSequence(history: readonly StageChange[]): void {
  history.forEach(validateRecord);
  for (let i = 1; i < history.length; i += 1) {
    if (history[i].at <= history[i - 1].at) {
      throw new RangeError(`history timestamps must be strictly increasing (index ${i})`);
    }
    if (history[i].stage === history[i - 1].stage) {
      throw new RangeError(`adjacent records must have different stages (index ${i})`);
    }
  }
}

/**
 * In-memory store of candidate stage histories for a single pipeline.
 */
export class PipelineStore {
  private readonly histories = new Map<string, StageChange[]>();

  /**
   * Submit (append/merge) stage history for one candidate.
   * History must be strictly increasing in time and have no equal adjacent stages.
   * New records are merged with the candidate's existing records; the merged
   * timeline must still be strictly increasing with differing adjacent stages.
   * On validation failure the stored history is left unchanged.
   */
  submitHistory(candidateId: string, history: StageChange[]): void {
    validateSequence(history);
    const existing = this.histories.get(candidateId) ?? [];
    const merged = [...existing, ...history.map((r) => ({ ...r }))].sort((a, b) => a.at - b.at);
    validateSequence(merged);
    this.histories.set(candidateId, merged);
  }

  /**
   * Replace the entire stage history of one candidate (used for backfilling / corrections).
   * After a successful call, reports must reflect only the new history.
   */
  replaceHistory(candidateId: string, history: StageChange[]): void {
    validateSequence(history);
    this.histories.set(candidateId, history.map((r) => ({ ...r })));
  }

  /** Internal accessor used by the report generator. */
  getHistories(): ReadonlyMap<string, readonly StageChange[]> {
    return this.histories;
  }
}

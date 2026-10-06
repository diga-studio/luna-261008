import { prepareHistory, type PreparedHistory } from "./prepare.js";
import { scorePreparedObjective } from "./score.js";
import type { ObjectiveHealth, OkrHistory } from "./types.js";

export * from "./types.js";

/**
 * In-memory OKR health scorer. All history is supplied by the caller at
 * construction time and treated as read-only; scoring state lives only in
 * this instance. Construction sorts and indexes the history once, after
 * which each query costs a handful of binary searches per key result.
 */
export class OkrHealthScorer {
  readonly #prepared: PreparedHistory;

  constructor(history: OkrHistory) {
    this.#prepared = prepareHistory(history);
  }

  /**
   * Health score of one objective at query time `time` (UTC seconds).
   * The scoring window is the fixed 28 days ending at `time`; records
   * after `time` never affect the result.
   */
  scoreObjective(objectiveId: string, time: number): ObjectiveHealth {
    const objective = this.#prepared.objectives.get(objectiveId);
    if (!objective) {
      throw new Error(`unknown objective id ${objectiveId}`);
    }
    return scorePreparedObjective(objective, time);
  }
}

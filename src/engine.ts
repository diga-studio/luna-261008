import type {
  CheckIn,
  ConfidenceReview,
  HealthScore,
  HistoryData,
  KrSpec,
  ObjectiveSpec,
  ScoreQuery,
} from './types.js';
import {
  SECONDS_PER_DAY,
  WINDOW_DAYS,
  WINDOW_SECONDS,
  FREQUENCY_BUCKETS,
} from './types.js';
import { KrIndex } from './kr-index.js';

const VELOCITY_WEIGHT = 0.4;
const FREQUENCY_WEIGHT = 0.3;
const TREND_WEIGHT = 0.3;

/** Trend score maps a slope of +/-18 points per 28 days to [0, 1]. */
const TREND_SLOPE_SPAN = 18;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface KrRuntime {
  readonly spec: KrSpec;
  readonly objective: ObjectiveSpec;
  index: KrIndex;
}

/**
 * In-memory OKR health scoring engine.
 *
 * The caller owns the data; the engine keeps only derived in-memory indexes.
 * History is read-only during scoring: records after a query time never
 * affect its result.
 */
export class OkrHealthEngine {
  private readonly objectiveById = new Map<string, ObjectiveSpec>();
  private readonly krById = new Map<string, KrRuntime>();
  private readonly krIdsByObjective = new Map<string, string[]>();

  constructor(
    readonly objectives: readonly ObjectiveSpec[],
    readonly krs: readonly KrSpec[],
  ) {
    for (const objective of objectives) {
      if (this.objectiveById.has(objective.id)) {
        throw new Error(`duplicate objective id: ${objective.id}`);
      }
      if (objective.end - objective.start < WINDOW_SECONDS) {
        throw new Error(
          `objective ${objective.id} cycle is shorter than ${WINDOW_DAYS} days`,
        );
      }
      this.objectiveById.set(objective.id, objective);
      this.krIdsByObjective.set(objective.id, []);
    }

    for (const kr of krs) {
      if (this.krById.has(kr.id)) {
        throw new Error(`duplicate KR id: ${kr.id}`);
      }
      const objective = this.objectiveById.get(kr.objectiveId);
      if (!objective) {
        throw new Error(`KR ${kr.id} references unknown objective ${kr.objectiveId}`);
      }
      if (kr.progressKind === 'number') {
        if (!(kr.targetValue !== undefined && kr.targetValue > 0)) {
          throw new Error(`KR ${kr.id} needs a positive targetValue`);
        }
      }
      this.krById.set(kr.id, {
        spec: kr,
        objective,
        index: KrIndex.build([], [], () => 0),
      });
      this.krIdsByObjective.get(kr.objectiveId)!.push(kr.id);
    }

    for (const objective of objectives) {
      const krIds = this.krIdsByObjective.get(objective.id)!;
      if (krIds.length < 1 || krIds.length > 5) {
        throw new Error(
          `objective ${objective.id} must have 1 to 5 KRs, got ${krIds.length}`,
        );
      }
      let weightSum = 0;
      for (const krId of krIds) {
        weightSum += this.krById.get(krId)!.spec.weight;
      }
      if (Math.abs(weightSum - 100) > 1e-9) {
        throw new Error(
          `objective ${objective.id} KR weights sum to ${weightSum}, expected 100`,
        );
      }
    }
  }

  /** Build in-memory indexes from the caller-provided history. */
  loadHistory(history: HistoryData): void {
    const checkInsByKr = new Map<string, { time: number; value: number }[]>();
    for (const checkIn of history.checkIns) {
      if (!this.krById.has(checkIn.krId)) continue;
      let list = checkInsByKr.get(checkIn.krId);
      if (!list) {
        list = [];
        checkInsByKr.set(checkIn.krId, list);
      }
      list.push({ time: checkIn.time, value: checkIn.value });
    }

    const reviewsByKr = new Map<string, { time: number; score: number }[]>();
    for (const review of history.reviews) {
      if (!this.krById.has(review.krId)) continue;
      let list = reviewsByKr.get(review.krId);
      if (!list) {
        list = [];
        reviewsByKr.set(review.krId, list);
      }
      list.push({ time: review.time, score: review.score });
    }

    for (const runtime of this.krById.values()) {
      const normalize = normalizerFor(runtime.spec);
      runtime.index = KrIndex.build(
        checkInsByKr.get(runtime.spec.id) ?? [],
        reviewsByKr.get(runtime.spec.id) ?? [],
        normalize,
      );
    }
  }

  /** Health score of one KR at time T (window [T - 28d, T]). */
  scoreKr(krId: string, time: number): HealthScore {
    const runtime = this.krById.get(krId);
    if (!runtime) throw new Error(`unknown KR id: ${krId}`);
    this.assertQueryable(runtime.objective, time);

    const L = time - WINDOW_SECONDS;
    const index = runtime.index;

    const cycleDays =
      (runtime.objective.end - runtime.objective.start) / SECONDS_PER_DAY;
    const velocity = clamp01(
      ((index.progressAt(time) - index.progressAt(L)) * cycleDays) / WINDOW_DAYS,
    );

    const frequency = index.frequencyHitBuckets(L) / FREQUENCY_BUCKETS;

    const { m0, m1 } = index.trendMoments(L, time);
    // Least-squares slope of the held-value confidence curve over the
    // window, with squared error integrated over elapsed time.
    const slopePerSecond =
      ((m1 - (m0 * WINDOW_SECONDS) / 2) * 12) /
      (WINDOW_SECONDS * WINDOW_SECONDS * WINDOW_SECONDS);
    const slopePerDay = slopePerSecond * SECONDS_PER_DAY;
    const trend = clamp01(0.5 + (WINDOW_DAYS * slopePerDay) / TREND_SLOPE_SPAN);

    return combine(velocity, frequency, trend);
  }

  /** Health score of one objective at time T: weight-weighted KR aggregate. */
  scoreObjective(objectiveId: string, time: number): HealthScore {
    const krIds = this.krIdsByObjective.get(objectiveId);
    if (!krIds) throw new Error(`unknown objective id: ${objectiveId}`);

    let velocity = 0;
    let frequency = 0;
    let trend = 0;
    for (const krId of krIds) {
      const runtime = this.krById.get(krId)!;
      const score = this.scoreKr(krId, time);
      const w = runtime.spec.weight / 100;
      velocity += w * score.velocity;
      frequency += w * score.frequency;
      trend += w * score.trend;
    }
    return combine(velocity, frequency, trend);
  }

  /** Batch scoring; results align with the input query order. */
  scoreBatch(queries: readonly ScoreQuery[]): HealthScore[] {
    return queries.map((q) => this.scoreObjective(q.objectiveId, q.time));
  }

  private assertQueryable(objective: ObjectiveSpec, time: number): void {
    if (time < objective.start + WINDOW_SECONDS || time > objective.end) {
      throw new RangeError(
        `query time ${time} outside [start + ${WINDOW_DAYS}d, end] for objective ${objective.id}`,
      );
    }
  }
}

function normalizerFor(spec: KrSpec): (raw: number) => number {
  switch (spec.progressKind) {
    case 'percent':
      return (raw) => clamp01(raw / 100);
    case 'number': {
      const target = spec.targetValue!;
      return (raw) => clamp01(raw / target);
    }
    case 'binary':
      return (raw) => clamp01(raw);
  }
}

function combine(velocity: number, frequency: number, trend: number): HealthScore {
  return {
    velocity,
    frequency,
    trend,
    health:
      VELOCITY_WEIGHT * velocity +
      FREQUENCY_WEIGHT * frequency +
      TREND_WEIGHT * trend,
  };
}

export type {
  CheckIn,
  ConfidenceReview,
  HealthScore,
  HistoryData,
  KrSpec,
  ObjectiveSpec,
  ScoreQuery,
};

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  OkrHealthEngine,
  WINDOW_SECONDS,
  SECONDS_PER_DAY,
} from '../src/index.js';
import type {
  CheckIn,
  ConfidenceReview,
  KrSpec,
  ObjectiveSpec,
  ScoreQuery,
} from '../src/index.js';
import { referenceObjectiveScore } from './reference.js';

const DAY = SECONDS_PER_DAY;

/** Deterministic PRNG (mulberry32) so the batch is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = 1_600_000_000; // ~2020, UTC seconds
const OBJECTIVE_COUNT = 80;
const CYCLE_DAYS = 90;
const KRS_PER_OBJECTIVE = 5;
const KR_WEIGHTS = [30, 25, 20, 15, 10];
const CHECK_IN_COUNT = 800_000;
const REVIEW_COUNT = 200_000;
const QUERY_COUNT = 50_000;
const TIME_BUDGET_MS = 10_000;

interface Batch {
  objectives: ObjectiveSpec[];
  krs: KrSpec[];
  checkIns: CheckIn[];
  reviews: ConfidenceReview[];
  queries: ScoreQuery[];
}

function generateBatch(seed: number): Batch {
  const rand = mulberry32(seed);

  const objectives: ObjectiveSpec[] = [];
  const krs: KrSpec[] = [];
  for (let o = 0; o < OBJECTIVE_COUNT; o++) {
    const start = BASE + o * CYCLE_DAYS * DAY;
    const objective: ObjectiveSpec = {
      id: `obj-${o}`,
      start,
      end: start + CYCLE_DAYS * DAY,
    };
    objectives.push(objective);
    for (let k = 0; k < KRS_PER_OBJECTIVE; k++) {
      const kind =
        k % 3 === 0 ? 'percent' : k % 3 === 1 ? 'number' : 'binary';
      const kr: KrSpec = {
        id: `kr-${o}-${k}`,
        objectiveId: objective.id,
        weight: KR_WEIGHTS[k]!,
        progressKind: kind,
        ...(kind === 'number' ? { targetValue: 1000 } : {}),
      };
      krs.push(kr);
    }
  }

  const krIds = krs.map((k) => k.id);
  const hotCount = Math.max(1, Math.floor(krIds.length * 0.05));
  const hotKrs = krIds.slice(0, hotCount); // 60% of records land here
  const spanSeconds = OBJECTIVE_COUNT * CYCLE_DAYS * DAY;

  const pickKr = (): string =>
    rand() < 0.6
      ? hotKrs[Math.floor(rand() * hotKrs.length)]!
      : krIds[Math.floor(rand() * krIds.length)]!;

  const usedTimes = new Map<string, Set<number>>();
  const uniqueTime = (key: string): number => {
    let set = usedTimes.get(key);
    if (!set) {
      set = new Set();
      usedTimes.set(key, set);
    }
    for (;;) {
      const t = BASE + Math.floor(rand() * spanSeconds);
      if (!set.has(t)) {
        set.add(t);
        return t;
      }
    }
  };

  const checkIns: CheckIn[] = new Array(CHECK_IN_COUNT);
  for (let i = 0; i < CHECK_IN_COUNT; i++) {
    const krId = pickKr();
    const kind = krs.find((k) => k.id === krId)!.progressKind;
    const value =
      kind === 'percent'
        ? Math.floor(rand() * 150)
        : kind === 'number'
          ? Math.floor(rand() * 1200)
          : rand() < 0.5
            ? 0
            : 1;
    checkIns[i] = { krId, time: uniqueTime(`c:${krId}`), value };
  }

  const reviews: ConfidenceReview[] = new Array(REVIEW_COUNT);
  for (let i = 0; i < REVIEW_COUNT; i++) {
    const krId = pickKr();
    reviews[i] = {
      krId,
      time: uniqueTime(`r:${krId}`),
      score: 1 + Math.floor(rand() * 10),
    };
  }

  const queries: ScoreQuery[] = new Array(QUERY_COUNT);
  for (let i = 0; i < QUERY_COUNT; i++) {
    const objective = objectives[Math.floor(rand() * objectives.length)]!;
    const earliest = objective.start + WINDOW_SECONDS;
    const time = earliest + Math.floor(rand() * (objective.end - earliest));
    queries[i] = { objectiveId: objective.id, time };
  }

  return { objectives, krs, checkIns, reviews, queries };
}

test(
  'batch: 1M records, 50k queries within 10s incl. preparation',
  { timeout: 120_000 },
  () => {
    const batch = generateBatch(20261008);
    assert.equal(batch.checkIns.length + batch.reviews.length, 1_000_000);
    assert.equal(batch.queries.length, QUERY_COUNT);

    const t0 = performance.now();
    const engine = new OkrHealthEngine(batch.objectives, batch.krs);
    engine.loadHistory({
      checkIns: batch.checkIns,
      reviews: batch.reviews,
    });
    const results = engine.scoreBatch(batch.queries);
    const elapsed = performance.now() - t0;

    assert.equal(results.length, QUERY_COUNT);
    for (const r of results) {
      assert.ok(r.health >= 0 && r.health <= 1, `health in range: ${r.health}`);
    }
    assert.ok(
      elapsed < TIME_BUDGET_MS,
      `batch took ${elapsed.toFixed(0)}ms, budget ${TIME_BUDGET_MS}ms`,
    );
    console.log(`batch: ${QUERY_COUNT} queries over 1M records in ${elapsed.toFixed(0)}ms`);

    // Spot-check selected queries against the independent reference.
    const krsByObjective = new Map<string, KrSpec[]>();
    for (const kr of batch.krs) {
      const list = krsByObjective.get(kr.objectiveId) ?? [];
      list.push(kr);
      krsByObjective.set(kr.objectiveId, list);
    }
    const objectiveById = new Map(batch.objectives.map((o) => [o.id, o]));
    const spotIdx = [0, 1, 7777, 12345, 25000, 39001, 49_999];
    for (const i of spotIdx) {
      const q = batch.queries[i]!;
      const actual = results[i]!;
      const expected = referenceObjectiveScore(
        krsByObjective.get(q.objectiveId)!,
        objectiveById.get(q.objectiveId)!,
        batch.checkIns,
        batch.reviews,
        q.time,
      );
      for (const key of ['velocity', 'frequency', 'trend', 'health'] as const) {
        assert.ok(
          Math.abs(actual[key] - expected[key]) <= 1e-8,
          `query ${i} ${key}: ${actual[key]} vs ${expected[key]}`,
        );
      }
    }
  },
);

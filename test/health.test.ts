import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/index.js';
import { referenceObjectiveScore } from './reference.js';

const DAY = SECONDS_PER_DAY;
const START = 1_700_000_000;

function makeObjective(days: number): ObjectiveSpec {
  return { id: 'obj', start: START, end: START + days * DAY };
}

const KRS: KrSpec[] = [
  { id: 'kr1', objectiveId: 'obj', weight: 60, progressKind: 'percent' },
  { id: 'kr2', objectiveId: 'obj', weight: 40, progressKind: 'number', targetValue: 200 },
];

function buildEngine(
  objectives: ObjectiveSpec[],
  krs: KrSpec[],
  checkIns: CheckIn[],
  reviews: ConfidenceReview[],
): OkrHealthEngine {
  const engine = new OkrHealthEngine(objectives, krs);
  engine.loadHistory({ checkIns, reviews });
  return engine;
}

function assertClose(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (eps ${eps})`,
  );
}

test('uneven review intervals; redundant same-value reviews keep score', () => {
  const objective = makeObjective(56);
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;

  const checkIns: CheckIn[] = [
    { krId: 'kr1', time: L - 2 * DAY, value: 40 },
    { krId: 'kr1', time: L + 3 * DAY, value: 55 },
    { krId: 'kr1', time: L + 17 * DAY, value: 70 },
    { krId: 'kr2', time: L + 1 * DAY, value: 50 },
    { krId: 'kr2', time: L + 25 * DAY, value: 120 },
  ];
  // Uneven intervals: 7d, 7d, 11d gaps, plus a pre-window review.
  const reviews: ConfidenceReview[] = [
    { krId: 'kr1', time: L - 5 * DAY, score: 4 },
    { krId: 'kr1', time: L + 2 * DAY, score: 7 },
    { krId: 'kr1', time: L + 9 * DAY, score: 3 },
    { krId: 'kr1', time: L + 20 * DAY, score: 9 },
    { krId: 'kr2', time: L + 6 * DAY, score: 6 },
  ];

  const engine = buildEngine([objective], KRS, checkIns, reviews);
  const base = engine.scoreObjective('obj', T);

  const expected = referenceObjectiveScore(KRS, objective, checkIns, reviews, T);
  assertClose(base.velocity, expected.velocity, 1e-12);
  assertClose(base.frequency, expected.frequency, 1e-12);
  assertClose(base.trend, expected.trend, 1e-12);
  assertClose(base.health, expected.health, 1e-12);

  // Insert reviews whose score equals the confidence in effect at that
  // moment: the held-value curve is unchanged, so the score must not move.
  const redundant: ConfidenceReview[] = [
    { krId: 'kr1', time: L - 3 * DAY, score: 4 },
    { krId: 'kr1', time: L + 5 * DAY, score: 7 },
    { krId: 'kr1', time: L + 15 * DAY, score: 3 },
    { krId: 'kr1', time: L + 27 * DAY, score: 9 },
    { krId: 'kr2', time: L + 10 * DAY, score: 6 },
  ];
  const engine2 = buildEngine(
    [objective],
    KRS,
    checkIns,
    [...reviews, ...redundant],
  );
  const after = engine2.scoreObjective('obj', T);
  assertClose(after.velocity, base.velocity, 1e-12);
  assertClose(after.frequency, base.frequency, 1e-12);
  assertClose(after.trend, base.trend, 1e-12);
  assertClose(after.health, base.health, 1e-12);
});

test('progress regression feeds velocity with sign', () => {
  const objective = makeObjective(56);
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;
  const checkIns: CheckIn[] = [
    { krId: 'kr1', time: L - 2 * DAY, value: 40 },
    { krId: 'kr1', time: L + 3 * DAY, value: 90 },
    { krId: 'kr1', time: L + 10 * DAY, value: 30 }, // regression
    { krId: 'kr1', time: T, value: 80 },
  ];
  const engine = buildEngine([objective], KRS, checkIns, []);
  const score = engine.scoreKr('kr1', T);
  // progress(L) = 0.4 (carried from before the window), progress(T) = 0.8.
  const cycleDays = 56;
  const expectedVelocity = ((0.8 - 0.4) * cycleDays) / 28;
  assertClose(score.velocity, expectedVelocity, 1e-12);

  // A window ending in a net regression clamps velocity to 0.
  const checkIns2: CheckIn[] = [
    { krId: 'kr1', time: START + DAY, value: 90 },
    { krId: 'kr1', time: START + 25 * DAY, value: 30 }, // regression
  ];
  const engine2 = buildEngine([objective], KRS, checkIns2, []);
  const T2 = START + 30 * DAY;
  const score2 = engine2.scoreKr('kr1', T2);
  assert.equal(score2.velocity, 0);
});

test('pre-window confidence carries in; flat curve gives trend 0.5', () => {
  const objective = makeObjective(56);
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;
  const reviews: ConfidenceReview[] = [
    { krId: 'kr1', time: L - 10 * DAY, score: 8 },
  ];
  const engine = buildEngine([objective], KRS, [], reviews);
  const score = engine.scoreKr('kr1', T);
  assertClose(score.trend, 0.5, 1e-12);

  // No reviews at all: default 5.5, still flat.
  const engineDefault = buildEngine([objective], KRS, [], []);
  assertClose(engineDefault.scoreKr('kr1', T).trend, 0.5, 1e-12);
});

test('check-in endpoint bucket membership', () => {
  const objective = makeObjective(56);
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;
  const checkIns: CheckIn[] = [
    { krId: 'kr1', time: L, value: 10 }, // bucket 0 (left-inclusive)
    { krId: 'kr1', time: L + 7 * DAY, value: 20 }, // bucket 1, not bucket 0
    { krId: 'kr1', time: L + 7 * DAY - 1, value: 20 }, // still bucket 0
    { krId: 'kr1', time: L + 21 * DAY + 3600, value: 30 }, // bucket 3
    { krId: 'kr1', time: T, value: 40 }, // excluded: right end of bucket 3
  ];
  const engine = buildEngine([objective], KRS, checkIns, []);
  const score = engine.scoreKr('kr1', T);
  // Buckets hit: 0, 1, 3 -> 3/4. The check-in at T belongs to no bucket.
  assertClose(score.frequency, 3 / 4, 1e-12);

  // Duplicate check-ins inside one bucket do not add extra credit.
  const more: CheckIn[] = [
    ...checkIns,
    { krId: 'kr1', time: L + 3600, value: 11 },
    { krId: 'kr1', time: L + 7200, value: 12 },
  ];
  const engine2 = buildEngine([objective], KRS, more, []);
  assertClose(engine2.scoreKr('kr1', T).frequency, 3 / 4, 1e-12);
});

test('future records never change historical results', () => {
  const objective = makeObjective(56);
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;
  const checkIns: CheckIn[] = [
    { krId: 'kr1', time: L + 4 * DAY, value: 50 },
    { krId: 'kr2', time: L + 8 * DAY, value: 80 },
  ];
  const reviews: ConfidenceReview[] = [
    { krId: 'kr1', time: L + 2 * DAY, score: 6 },
    { krId: 'kr2', time: L + 12 * DAY, score: 8 },
  ];
  const engine = buildEngine([objective], KRS, checkIns, reviews);
  const before = engine.scoreObjective('obj', T);

  const futureCheckIns: CheckIn[] = [
    { krId: 'kr1', time: T + 1, value: 100 },
    { krId: 'kr1', time: T + 5 * DAY, value: 5 },
    { krId: 'kr2', time: T + 2 * DAY, value: 200 },
  ];
  const futureReviews: ConfidenceReview[] = [
    { krId: 'kr1', time: T + 1, score: 1 },
    { krId: 'kr2', time: T + 3 * DAY, score: 10 },
  ];
  const engine2 = buildEngine(
    [objective],
    KRS,
    [...checkIns, ...futureCheckIns],
    [...reviews, ...futureReviews],
  );
  const after = engine2.scoreObjective('obj', T);
  assert.equal(after.velocity, before.velocity);
  assert.equal(after.frequency, before.frequency);
  assert.equal(after.trend, before.trend);
  assert.equal(after.health, before.health);
});

test('normalization: percent clamps, number scales, binary maps', () => {
  const objective = makeObjective(56);
  const krs: KrSpec[] = [
    { id: 'kp', objectiveId: 'obj', weight: 40, progressKind: 'percent' },
    { id: 'kn', objectiveId: 'obj', weight: 40, progressKind: 'number', targetValue: 200 },
    { id: 'kb', objectiveId: 'obj', weight: 20, progressKind: 'binary' },
  ];
  const T = START + 40 * DAY;
  const L = T - WINDOW_SECONDS;
  const checkIns: CheckIn[] = [
    { krId: 'kp', time: L + DAY, value: 250 }, // clamps to 1
    { krId: 'kn', time: L + DAY, value: 50 }, // 0.25
    { krId: 'kb', time: L + DAY, value: 1 }, // 1
  ];
  const engine = buildEngine([objective], krs, checkIns, []);
  // velocity = progress delta (from 0) * 56 / 28, clamped to [0, 1].
  assertClose(engine.scoreKr('kp', T).velocity, 1, 1e-12); // 1 * 2 -> clamps
  assertClose(engine.scoreKr('kn', T).velocity, 0.5, 1e-12); // 0.25 * 2
  assertClose(engine.scoreKr('kb', T).velocity, 1, 1e-12); // 1 * 2 -> clamps
});

test('query time validation', () => {
  const objective = makeObjective(56);
  const engine = buildEngine([objective], KRS, [], []);
  assert.throws(
    () => engine.scoreObjective('obj', START + 27 * DAY),
    RangeError,
  );
  assert.throws(() => engine.scoreObjective('obj', START + 57 * DAY), RangeError);
  // Boundary: exactly start + 28d and exactly end are queryable.
  engine.scoreObjective('obj', START + WINDOW_SECONDS);
  engine.scoreObjective('obj', START + 56 * DAY);
});

test('spec validation', () => {
  const objective = makeObjective(56);
  assert.throws(() => new OkrHealthEngine([{ id: 'o', start: START, end: START + 20 * DAY }], []));
  assert.throws(() => new OkrHealthEngine([objective], KRS.slice(0, 1))); // weights 60 != 100
  assert.throws(
    () =>
      new OkrHealthEngine([objective], [
        { id: 'k', objectiveId: 'obj', weight: 100, progressKind: 'number' },
      ]),
  );
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OkrHealthScorer,
  SECONDS_PER_DAY,
  type CheckIn,
  type ConfidenceRecord,
  type OkrHistory,
} from "../src/index.js";
import { ReferenceScorer } from "./reference.js";

const DAY = SECONDS_PER_DAY;
const START = 1_700_000_000;
const END = START + 60 * DAY;
const T = START + 40 * DAY;
const L = T - 28 * DAY;

function makeHistory(
  checkIns: CheckIn[],
  confidenceRecords: ConfidenceRecord[],
  krs: OkrHistory["objectives"][number]["krs"] = [
    { id: "kr1", weight: 100, progressKind: "percentage" },
  ],
): OkrHistory {
  return {
    objectives: [{ id: "obj", start: START, end: END, krs }],
    checkIns,
    confidenceRecords,
  };
}

function closeTo(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

function referenceScore(history: OkrHistory, T: number) {
  return new ReferenceScorer(history).scoreObjective("obj", T);
}

describe("business rules", () => {
  it("handles unequal-interval confidence records; inserting same-value records changes nothing", () => {
    const checkIns: CheckIn[] = [
      { krId: "kr1", time: L + 1 * DAY, value: 20 },
      { krId: "kr1", time: L + 10 * DAY, value: 50 },
      { krId: "kr1", time: L + 20 * DAY, value: 45 },
    ];
    const confidence: ConfidenceRecord[] = [
      { krId: "kr1", time: L - 5 * DAY, confidence: 6 },
      { krId: "kr1", time: L + 3 * DAY, confidence: 8 },
      { krId: "kr1", time: L + 9 * DAY, confidence: 5 },
      { krId: "kr1", time: L + 25 * DAY, confidence: 9 },
    ];
    const base = makeHistory(checkIns, confidence);
    const score1 = new OkrHealthScorer(base).scoreObjective("obj", T);

    // Cross-check against the independent reference implementation.
    const ref = referenceScore(base, T);
    closeTo(score1.velocity, ref.velocity);
    closeTo(score1.frequency, ref.frequency);
    closeTo(score1.trend, ref.trend);
    closeTo(score1.health, ref.health);

    // Insert evaluations equal to the confidence in effect at their times.
    const withDuplicates = makeHistory(checkIns, [
      ...confidence,
      { krId: "kr1", time: L - 2 * DAY, confidence: 6 },
      { krId: "kr1", time: L + 5 * DAY, confidence: 8 },
      { krId: "kr1", time: L + 15 * DAY, confidence: 5 },
      { krId: "kr1", time: L + 27 * DAY, confidence: 9 },
    ]);
    const score2 = new OkrHealthScorer(withDuplicates).scoreObjective("obj", T);
    assert.deepEqual(score2, score1);
  });

  it("allows progress regression and clamps negative velocity to 0", () => {
    const history = makeHistory(
      [
        { krId: "kr1", time: L - 1 * DAY, value: 80 },
        { krId: "kr1", time: L + 10 * DAY, value: 30 },
      ],
      [],
    );
    const score = new OkrHealthScorer(history).scoreObjective("obj", T);
    // Progress fell from 0.8 to 0.3 across the window: negative gain.
    assert.equal(score.velocity, 0);
    const ref = referenceScore(history, T);
    closeTo(score.health, ref.health);
    // The regression is real, not hidden: mid-window queries see the drop.
    const mid = new OkrHealthScorer(history).scoreObjective("obj", L + 28 * DAY);
    assert.equal(mid.velocity, 0);
  });

  it("carries pre-window state into the window", () => {
    const history = makeHistory(
      [{ krId: "kr1", time: L - 3 * DAY, value: 60 }],
      [{ krId: "kr1", time: L - 10 * DAY, confidence: 9 }],
    );
    const score = new OkrHealthScorer(history).scoreObjective("obj", T);
    // Progress flat at 0.6 across the window: no velocity.
    assert.equal(score.velocity, 0);
    // Confidence flat at 9: zero slope, trend is the neutral 0.5.
    closeTo(score.trend, 0.5);
    assert.equal(score.frequency, 0);
  });

  it("assigns check-ins at slot boundaries to the slot on their right", () => {
    const at = (days: number): CheckIn => ({ krId: "kr1", time: L + days * DAY, value: 10 });
    // Check-ins exactly at L, L+7, L+14, L+21 occupy all four slots;
    // a check-in exactly at T belongs to no slot.
    const allSlots = new OkrHealthScorer(
      makeHistory([at(0), at(7), at(14), at(21), at(28)], []),
    ).scoreObjective("obj", T);
    assert.equal(allSlots.frequency, 1);

    // Only right endpoints (including T): the first slot is empty.
    const rightEdges = new OkrHealthScorer(
      makeHistory([at(7), at(14), at(21), at(28)], []),
    ).scoreObjective("obj", T);
    assert.equal(rightEdges.frequency, 0.75);

    // Only T: no slot scored.
    const onlyT = new OkrHealthScorer(makeHistory([at(28)], [])).scoreObjective("obj", T);
    assert.equal(onlyT.frequency, 0);
  });

  it("ignores records after the query time", () => {
    const checkIns: CheckIn[] = [
      { krId: "kr1", time: L + 2 * DAY, value: 10 },
      { krId: "kr1", time: L + 16 * DAY, value: 70 },
    ];
    const confidence: ConfidenceRecord[] = [
      { krId: "kr1", time: L + 4 * DAY, confidence: 4 },
      { krId: "kr1", time: L + 18 * DAY, confidence: 8 },
    ];
    const base = makeHistory(checkIns, confidence);
    const score1 = new OkrHealthScorer(base).scoreObjective("obj", T);

    const withFuture = makeHistory(
      [
        ...checkIns,
        { krId: "kr1", time: T + 1, value: 100 },
        { krId: "kr1", time: T + 5 * DAY, value: 0 },
      ],
      [
        ...confidence,
        { krId: "kr1", time: T + 1, confidence: 1 },
        { krId: "kr1", time: T + 9 * DAY, confidence: 10 },
      ],
    );
    const score2 = new OkrHealthScorer(withFuture).scoreObjective("obj", T);
    assert.deepEqual(score2, score1);
  });

  it("uses defaults with no records: progress 0, confidence 5.5", () => {
    const score = new OkrHealthScorer(makeHistory([], [])).scoreObjective("obj", T);
    assert.equal(score.velocity, 0);
    assert.equal(score.frequency, 0);
    closeTo(score.trend, 0.5);
    closeTo(score.health, 0.15);
  });

  it("computes the continuous-time least-squares trend exactly", () => {
    // Confidence 4 before the window, 8 from the window midpoint on.
    const history = makeHistory(
      [],
      [
        { krId: "kr1", time: L - 1 * DAY, confidence: 4 },
        { krId: "kr1", time: L + 14 * DAY, confidence: 8 },
      ],
    );
    const score = new OkrHealthScorer(history).scoreObjective("obj", T);
    // Slope of the time-weighted fit is exactly 3/14 points/day,
    // so trend = 0.5 + 28*(3/14)/18 = 5/6.
    closeTo(score.trend, 5 / 6);
  });

  it("treats an evaluation exactly at T as zero-duration in the window", () => {
    const without = new OkrHealthScorer(
      makeHistory([], [{ krId: "kr1", time: L - 1 * DAY, confidence: 7 }]),
    ).scoreObjective("obj", T);
    const withAtT = new OkrHealthScorer(
      makeHistory(
        [],
        [
          { krId: "kr1", time: L - 1 * DAY, confidence: 7 },
          { krId: "kr1", time: T, confidence: 1 },
        ],
      ),
    ).scoreObjective("obj", T);
    assert.deepEqual(withAtT, without);
  });

  it("normalizes numeric and binary progress and clamps to [0, 1]", () => {
    const history = makeHistory(
      [
        { krId: "num", time: L + 1 * DAY, value: 100 },
        { krId: "num", time: L + 5 * DAY, value: 250 },
        { krId: "bin", time: L + 2 * DAY, value: 1 },
      ],
      [],
      [
        { id: "num", weight: 60, progressKind: "numeric", targetValue: 200 },
        { id: "bin", weight: 40, progressKind: "binary" },
      ],
    );
    const score = new OkrHealthScorer(history).scoreObjective("obj", T);
    const num = score.krs.find((k) => k.krId === "num")!;
    const bin = score.krs.find((k) => k.krId === "bin")!;
    // 250/200 clamps to 1; velocity = (1 - 0) * 60 / 28 clamps to 1.
    assert.equal(num.velocity, 1);
    // Binary 1 held from L+2d: gain 1 * 60/28 clamps to 1.
    assert.equal(bin.velocity, 1);
    closeTo(score.velocity, 0.6 * 1 + 0.4 * 1);
  });

  it("weights key results into the objective score", () => {
    const history = makeHistory(
      [
        { krId: "a", time: L + 1 * DAY, value: 50 },
        { krId: "b", time: L + 1 * DAY, value: 100 },
      ],
      [],
      [
        { id: "a", weight: 25, progressKind: "percentage" },
        { id: "b", weight: 75, progressKind: "percentage" },
      ],
    );
    const score = new OkrHealthScorer(history).scoreObjective("obj", T);
    const ref = referenceScore(history, T);
    closeTo(score.health, ref.health);
    closeTo(score.health, 0.4 * score.velocity + 0.3 * score.frequency + 0.3 * score.trend);
  });

  it("validates objectives and query times", () => {
    assert.throws(
      () =>
        new OkrHealthScorer(
          makeHistory([], [], [{ id: "kr1", weight: 90, progressKind: "percentage" }]),
        ),
      /weights must sum to 100/,
    );
    assert.throws(
      () =>
        new OkrHealthScorer(
          makeHistory([], [], [{ id: "kr1", weight: 100, progressKind: "numeric" }]),
        ),
      /positive targetValue/,
    );
    const scorer = new OkrHealthScorer(makeHistory([], []));
    assert.throws(() => scorer.scoreObjective("obj", START + 27 * DAY), /outside/);
    assert.throws(() => scorer.scoreObjective("obj", END + 1), /outside/);
    assert.throws(() => scorer.scoreObjective("nope", T), /unknown objective/);
    // The objective end itself is queryable.
    assert.doesNotThrow(() => scorer.scoreObjective("obj", END));
  });
});

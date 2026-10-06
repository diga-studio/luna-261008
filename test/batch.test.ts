import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OkrHealthScorer,
  SECONDS_PER_DAY,
  type CheckIn,
  type ConfidenceRecord,
  type KeyResultSpec,
  type ObjectiveSpec,
  type OkrHistory,
} from "../src/index.js";
import { ReferenceScorer } from "./reference.js";

const DAY = SECONDS_PER_DAY;
const BASE = 630_720_000; // 1990-01-01T00:00:00Z
const TWENTY_YEARS = 20 * 365 * DAY;
const OBJECTIVE_COUNT = 200;
const KRS_PER_OBJECTIVE = 5;
const PERIOD_DAYS = 90;
const CHECK_IN_COUNT = 600_000;
const CONFIDENCE_COUNT = 400_000;
const QUERY_COUNT = 50_000;
const HOT_KR_COUNT = 10;
const HOT_SHARE = 0.7;
const TIME_BUDGET_MS = 10_000;
const CROSS_CHECK_COUNT = 25;
const TOLERANCE = 1e-8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  history: OkrHistory;
  objectives: ObjectiveSpec[];
  hotObjectiveIds: string[];
}

function generate(rand: () => number): Generated {
  const objectives: ObjectiveSpec[] = [];
  const allKrs: KeyResultSpec[] = [];
  const span = TWENTY_YEARS - PERIOD_DAYS * DAY;
  for (let i = 0; i < OBJECTIVE_COUNT; i++) {
    const start = BASE + Math.floor((i / OBJECTIVE_COUNT) * span);
    const end = start + PERIOD_DAYS * DAY;
    const kinds: KeyResultSpec["progressKind"][] = ["percentage", "numeric", "binary"];
    const krs: KeyResultSpec[] = [];
    for (let k = 0; k < KRS_PER_OBJECTIVE; k++) {
      const kind = kinds[(i + k) % kinds.length]!;
      krs.push({
        id: `obj${i}-kr${k}`,
        weight: 100 / KRS_PER_OBJECTIVE,
        progressKind: kind,
        ...(kind === "numeric" ? { targetValue: 50 + ((i * 7 + k * 13) % 950) } : {}),
      });
    }
    allKrs.push(...krs);
    objectives.push({ id: `obj${i}`, start, end, krs });
  }

  const hotKrs = allKrs.slice(0, HOT_KR_COUNT);
  const coldKrs = allKrs.slice(HOT_KR_COUNT);
  const krObjective = new Map<string, ObjectiveSpec>();
  for (const obj of objectives) {
    for (const kr of obj.krs) krObjective.set(kr.id, obj);
  }

  const checkIns: CheckIn[] = [];
  const confidenceRecords: ConfidenceRecord[] = [];

  const hotCheckIns = Math.floor(CHECK_IN_COUNT * HOT_SHARE);
  const hotConfidence = Math.floor(CONFIDENCE_COUNT * HOT_SHARE);

  const fillTimes = (count: number, krs: KeyResultSpec[], sink: (krId: string, time: number) => void): void => {
    const perKr = Math.floor(count / krs.length);
    const remainder = count - perKr * krs.length;
    for (let k = 0; k < krs.length; k++) {
      const kr = krs[k]!;
      const obj = krObjective.get(kr.id)!;
      const used = new Set<number>();
      const target = perKr + (k < remainder ? 1 : 0);
      for (let n = 0; n < target; n++) {
        let time = obj.start + Math.floor(rand() * (obj.end - obj.start));
        while (used.has(time)) time = obj.start + Math.floor(rand() * (obj.end - obj.start));
        used.add(time);
        sink(kr.id, time);
      }
    }
  };

  fillTimes(hotCheckIns, hotKrs, (krId, time) =>
    checkIns.push({ krId, time, value: rand() * 120 }),
  );
  fillTimes(CHECK_IN_COUNT - hotCheckIns, coldKrs, (krId, time) =>
    checkIns.push({ krId, time, value: rand() * 120 }),
  );
  fillTimes(hotConfidence, hotKrs, (krId, time) =>
    confidenceRecords.push({ krId, time, confidence: 1 + Math.floor(rand() * 10) }),
  );
  fillTimes(CONFIDENCE_COUNT - hotConfidence, coldKrs, (krId, time) =>
    confidenceRecords.push({ krId, time, confidence: 1 + Math.floor(rand() * 10) }),
  );

  return {
    history: { objectives, checkIns, confidenceRecords },
    objectives,
    hotObjectiveIds: hotKrs.map((kr) => krObjective.get(kr.id)!.id),
  };
}

function generateQueries(rand: () => number, objectives: ObjectiveSpec[]): { id: string; time: number }[] {
  // Cluster centers per objective make query windows overlap heavily.
  const centers = objectives.map((obj) => {
    const lo = obj.start + 28 * DAY;
    const list: number[] = [];
    for (let c = 0; c < 3; c++) list.push(lo + Math.floor(rand() * (obj.end - lo)));
    return list;
  });
  const queries: { id: string; time: number }[] = [];
  for (let q = 0; q < QUERY_COUNT; q++) {
    const idx = Math.floor(rand() * objectives.length);
    const obj = objectives[idx]!;
    const center = centers[idx]![Math.floor(rand() * 3)]!;
    const jitter = Math.floor(rand() * 6 * DAY) - 3 * DAY;
    const time = Math.min(obj.end, Math.max(obj.start + 28 * DAY, center + jitter));
    queries.push({ id: obj.id, time });
  }
  return queries;
}

describe("batch workload", () => {
  it("prepares 1M records and answers 50k queries within the time budget, matching the reference", () => {
    const rand = mulberry32(20261008);
    const { history, objectives, hotObjectiveIds } = generate(rand);
    assert.equal(history.checkIns.length + history.confidenceRecords.length, 1_000_000);
    const queries = generateQueries(rand, objectives);
    assert.equal(queries.length, QUERY_COUNT);

    // Timed section: first-time data preparation plus all queries.
    const started = performance.now();
    const scorer = new OkrHealthScorer(history);
    let checksum = 0;
    const results: { id: string; time: number; health: number }[] = [];
    for (const q of queries) {
      const score = scorer.scoreObjective(q.id, q.time);
      checksum += score.health;
      results.push({ id: q.id, time: q.time, health: score.health });
    }
    const elapsed = performance.now() - started;
    assert.ok(Number.isFinite(checksum));
    assert.ok(
      elapsed < TIME_BUDGET_MS,
      `batch took ${elapsed.toFixed(0)}ms, budget is ${TIME_BUDGET_MS}ms`,
    );

    // Cross-check selected queries against the independent reference,
    // including objectives holding the record-concentrated "hot" KRs.
    const reference = new ReferenceScorer(history);
    const picked = new Set<string>();
    for (let i = 0; i < CROSS_CHECK_COUNT; i++) {
      const q: { id: string; time: number } = queries[Math.floor(rand() * queries.length)]!;
      const key: string = `${q.id}@${q.time}`;
      if (picked.has(key)) continue;
      picked.add(key);
      const actual = scorer.scoreObjective(q.id, q.time);
      const expected = reference.scoreObjective(q.id, q.time);
      for (const field of ["velocity", "frequency", "trend", "health"] as const) {
        assert.ok(
          Math.abs(actual[field] - expected[field]) <= TOLERANCE,
          `${key} ${field}: ${actual[field]} vs reference ${expected[field]}`,
        );
      }
    }
    // Explicitly cross-check the hot objectives too.
    for (const id of hotObjectiveIds.slice(0, 3)) {
      const obj = objectives.find((o) => o.id === id)!;
      const time = obj.start + 50 * DAY;
      const actual = scorer.scoreObjective(id, time);
      const expected = reference.scoreObjective(id, time);
      for (const field of ["velocity", "frequency", "trend", "health"] as const) {
        assert.ok(
          Math.abs(actual[field] - expected[field]) <= TOLERANCE,
          `${id} ${field}: ${actual[field]} vs reference ${expected[field]}`,
        );
      }
    }

    console.log(
      `batch: 1M records prepared and ${QUERY_COUNT} queries answered in ${elapsed.toFixed(0)}ms`,
    );
  });
});

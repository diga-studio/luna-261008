import assert from "node:assert/strict";
import test from "node:test";
import { TalentBridge } from "../src/index.js";
import type { Candidate, Job, ZipCoordinate } from "../src/index.js";

const JOB_COUNT = 100_000;
const CAND_COUNT = 50_000;
const ZIP_COUNT = 2_000;
const CLUSTER_JOB_COUNT = 12_000;
const QUERY_COUNT_PER_DIRECTION = 500;
const LOAD_BUDGET_MS = 30_000;
const QUERY_BUDGET_MS = 10_000;
const RSS_BUDGET_BYTES = 512 * 1024 * 1024;

/** Deterministic PRNG (mulberry32) so the perf dataset is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKILL_POOL = Array.from({ length: 200 }, (_, i) => `s${String(i).padStart(3, "0")}`);

function buildData() {
  const rand = rng(20261006);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const zips: ZipCoordinate[] = [{ zip: "CLUSTER", lat: 40.7, lon: -74.0 }];
  for (let i = 0; i < ZIP_COUNT; i++) {
    zips.push({
      zip: `Z${String(i).padStart(5, "0")}`,
      lat: 30 + rand() * 15,
      lon: -120 + rand() * 50,
    });
  }

  const randomSkills = (max: number): string[] => {
    const n = 1 + Math.floor(rand() * max);
    const set = new Set<string>();
    // Common skills: s000 in ~60% of objects, s001 in ~55% (>= half of all jobs covered).
    if (rand() < 0.6) set.add("s000");
    if (rand() < 0.55) set.add("s001");
    while (set.size < n) set.add(pick(SKILL_POOL));
    return [...set];
  };
  const randomSlots = (): number[] => {
    const n = 1 + Math.floor(rand() * 6);
    const set = new Set<number>();
    while (set.size < n) set.add(Math.floor(rand() * 14));
    return [...set];
  };

  const jobs: Job[] = [];
  for (let i = 0; i < JOB_COUNT; i++) {
    // >10k jobs clustered on a single zip; the rest spread out.
    const zip = i < CLUSTER_JOB_COUNT ? "CLUSTER" : pick(zips).zip;
    jobs.push({ id: `J${i}`, zip, skills: randomSkills(15), timeSlots: randomSlots() });
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < CAND_COUNT; i++) {
    candidates.push({
      id: `C${i}`,
      zip: pick(zips).zip,
      skills: randomSkills(20),
      timeSlots: randomSlots(),
      maxCommuteMiles: 5 + 5 * Math.floor(rand() * 10),
    });
  }
  return { jobs, candidates, zips };
}

test("perf: 100k jobs / 50k candidates load and 1000 queries within budget", () => {
  const tb = new TalentBridge();
  const queryIds = (() => {
    const data = buildData();
    const rand = rng(99);
    const candIds = Array.from({ length: QUERY_COUNT_PER_DIRECTION }, () =>
      Math.floor(rand() * CAND_COUNT),
    ).map((i) => `C${i}`);
    const jobIds = Array.from({ length: QUERY_COUNT_PER_DIRECTION }, () =>
      Math.floor(rand() * JOB_COUNT),
    ).map((i) => `J${i}`);

    const t0 = performance.now();
    tb.loadData(data);
    const loadMs = performance.now() - t0;
    console.log(`load: ${loadMs.toFixed(0)}ms for ${JOB_COUNT} jobs / ${CAND_COUNT} candidates`);
    assert.ok(loadMs < LOAD_BUDGET_MS, `load took ${loadMs}ms`);
    return { candIds, jobIds };
  })();

  const t1 = performance.now();
  let nonEmpty = 0;
  for (const id of queryIds.candIds) {
    const res = tb.recommendJobsForCandidate(id);
    assert.ok(res.length <= 25);
    if (res.length > 0) nonEmpty++;
  }
  for (const id of queryIds.jobIds) {
    const res = tb.recommendCandidatesForJob(id);
    assert.ok(res.length <= 25);
    if (res.length > 0) nonEmpty++;
  }
  const queryMs = performance.now() - t1;
  console.log(`queries: ${queryMs.toFixed(0)}ms for 1000 queries (${nonEmpty} non-empty)`);
  assert.ok(queryMs < QUERY_BUDGET_MS, `queries took ${queryMs}ms`);
  assert.ok(nonEmpty > 900, "most queries should return results");

  // Determinism at scale: identical repeat query, identical order.
  assert.deepEqual(
    tb.recommendJobsForCandidate(queryIds.candIds[0]),
    tb.recommendJobsForCandidate(queryIds.candIds[0]),
  );

  const rss = process.memoryUsage().rss;
  console.log(`peak rss: ${(rss / 1024 / 1024).toFixed(0)} MiB`);
  assert.ok(rss < RSS_BUDGET_BYTES, `rss ${rss} exceeds 512 MiB`);
});

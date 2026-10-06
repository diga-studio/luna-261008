import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TalentBridge,
  compositeScore,
  haversineMiles,
  round6,
} from '../src/index.js';
import type { Candidate, Job, LoadInput, ZipCoord } from '../src/index.js';

const JOB_COUNT = 100_000;
const CANDIDATE_COUNT = 50_000;
const ZIP_COUNT = 2_000;
const CLUSTER_ZIP = 'Z_CLUSTER';
const CLUSTER_JOB_COUNT = 10_500;

/** Deterministic PRNG so the dataset (and therefore every assertion) is stable. */
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

function buildDataset(): LoadInput {
  const rand = mulberry32(26100801);
  const zipCodes: Record<string, ZipCoord> = {};
  const zipIds: string[] = [];
  // Dense metro region: ~4 x 6 degrees, so a 50-mile radius covers many zips.
  for (let i = 0; i < ZIP_COUNT; i++) {
    const id = `Z${i}`;
    zipIds.push(id);
    zipCodes[id] = { lat: 38 + rand() * 4, lon: -78 + rand() * 6 };
  }
  // Antimeridian pair to exercise the short-way distance at scale.
  zipIds.push('Z_ANTI_A', 'Z_ANTI_B');
  zipCodes.Z_ANTI_A = { lat: 60, lon: 179.9 };
  zipCodes.Z_ANTI_B = { lat: 60, lon: -179.9 };
  // Heavily clustered zip.
  zipIds.push(CLUSTER_ZIP);
  zipCodes[CLUSTER_ZIP] = { lat: 40.7, lon: -74 };

  const commonSkills = ['common-0', 'common-1', 'common-2'];
  const skillPool: string[] = [...commonSkills];
  for (let i = 0; i < 60; i++) skillPool.push(`skill-${i}`);

  const pickSkills = (max: number): string[] => {
    const count = 1 + Math.floor(rand() * max);
    const skills = new Set<string>();
    // Common skills each cover well over half of all objects.
    for (const s of commonSkills) if (rand() < 0.6) skills.add(s);
    while (skills.size < count) {
      skills.add(skillPool[Math.floor(rand() * skillPool.length)]);
    }
    return [...skills];
  };
  const pickSlots = (): number[] => {
    const slots: number[] = [];
    for (let s = 0; s < 14; s++) if (rand() < 0.4) slots.push(s);
    if (slots.length === 0) slots.push(Math.floor(rand() * 14));
    return slots;
  };

  const jobs: Job[] = [];
  for (let i = 0; i < JOB_COUNT; i++) {
    // More than 10k jobs share a single zip.
    const zip = i < CLUSTER_JOB_COUNT ? CLUSTER_ZIP : zipIds[Math.floor(rand() * zipIds.length)];
    jobs.push({ id: `J${i}`, zip, skills: pickSkills(15), slots: pickSlots() });
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const zip = zipIds[Math.floor(rand() * zipIds.length)];
    candidates.push({
      id: `C${i}`,
      zip,
      skills: pickSkills(20),
      slots: pickSlots(),
      maxCommuteMiles: 5 + 5 * Math.floor(rand() * 10),
    });
  }
  return { jobs, candidates, zipCodes };
}

/** Independent O(n) reference implementation for cross-checking. */
function bruteForceJobs(input: LoadInput, candidateId: string): { jobId: string; score: number }[] {
  const cand = input.candidates.find((c) => c.id === candidateId)!;
  const cZip = input.zipCodes[cand.zip];
  const out: { jobId: string; score: number }[] = [];
  for (const job of input.jobs) {
    const jZip = input.zipCodes[job.zip];
    const d = haversineMiles(cZip.lat, cZip.lon, jZip.lat, jZip.lon);
    if (d > cand.maxCommuteMiles) continue;
    const common = job.skills.filter((s) => cand.skills.includes(s)).length;
    const skillRatio = job.skills.length === 0 ? 1 : common / job.skills.length;
    const commuteRatio = 1 - d / cand.maxCommuteMiles;
    const commonSlots = job.slots.filter((s) => cand.slots.includes(s)).length;
    const timeRatio = commonSlots / job.slots.length;
    out.push({ jobId: job.id, score: round6(compositeScore(skillRatio, commuteRatio, timeRatio)) });
  }
  out.sort((a, b) => b.score - a.score || (a.jobId < b.jobId ? -1 : 1));
  return out.slice(0, 25);
}

function bruteForceCandidates(input: LoadInput, jobId: string): { candidateId: string; score: number }[] {
  const job = input.jobs.find((j) => j.id === jobId)!;
  const jZip = input.zipCodes[job.zip];
  const out: { candidateId: string; score: number }[] = [];
  for (const cand of input.candidates) {
    const cZip = input.zipCodes[cand.zip];
    const d = haversineMiles(jZip.lat, jZip.lon, cZip.lat, cZip.lon);
    if (d > cand.maxCommuteMiles) continue;
    const common = job.skills.filter((s) => cand.skills.includes(s)).length;
    const skillRatio = job.skills.length === 0 ? 1 : common / job.skills.length;
    const commuteRatio = 1 - d / cand.maxCommuteMiles;
    const commonSlots = job.slots.filter((s) => cand.slots.includes(s)).length;
    const timeRatio = commonSlots / job.slots.length;
    out.push({ candidateId: cand.id, score: round6(compositeScore(skillRatio, commuteRatio, timeRatio)) });
  }
  out.sort((a, b) => b.score - a.score || (a.candidateId < b.candidateId ? -1 : 1));
  return out.slice(0, 25);
}

test(
  '100k jobs / 50k candidates: load < 30s, 1000 queries < 10s, exact order',
  { timeout: 120_000 },
  () => {
    const input = buildDataset();
    const commonCount = input.jobs.filter((j) => j.skills.includes('common-0')).length;
    assert.ok(
      commonCount >= JOB_COUNT / 2,
      `precondition: common skill covers ${commonCount} jobs (>= half)`,
    );
    assert.ok(
      input.jobs.filter((j) => j.zip === CLUSTER_ZIP).length > 10_000,
      'precondition: cluster zip holds > 10k jobs',
    );

    const tb = new TalentBridge();
    const loadStart = performance.now();
    tb.load(input);
    const loadMs = performance.now() - loadStart;
    console.log(`load: ${loadMs.toFixed(0)}ms`);
    assert.ok(loadMs < 30_000, `load took ${loadMs}ms`);

    // Exactness cross-check against the brute-force reference, including
    // objects sitting on the antimeridian pair.
    const spotCandidates = ['C0', 'C1', 'C2', 'C3', 'C4'];
    const spotJobs = ['J0', 'J1', 'J2', 'J3', 'J4'];
    for (const id of spotCandidates) {
      assert.deepEqual(tb.recommendJobs(id), bruteForceJobs(input, id), `jobs for ${id}`);
    }
    for (const id of spotJobs) {
      assert.deepEqual(tb.recommendCandidates(id), bruteForceCandidates(input, id), `candidates for ${id}`);
    }

    // 500 + 500 distinct-object queries.
    const queryStart = performance.now();
    let totalHits = 0;
    for (let i = 0; i < 500; i++) {
      totalHits += tb.recommendJobs(`C${(i * 97) % CANDIDATE_COUNT}`).length;
      totalHits += tb.recommendCandidates(`J${(i * 181) % JOB_COUNT}`).length;
    }
    const queryMs = performance.now() - queryStart;
    console.log(`1000 queries: ${queryMs.toFixed(0)}ms (hits: ${totalHits})`);
    assert.ok(totalHits > 0, 'queries should return results');
    assert.ok(queryMs < 10_000, `1000 queries took ${queryMs}ms`);

    // Identical repeated queries must return identical order.
    const first = tb.recommendJobs('C123');
    const second = tb.recommendJobs('C123');
    assert.deepEqual(first, second);
    const firstC = tb.recommendCandidates('J456');
    assert.deepEqual(firstC, tb.recommendCandidates('J456'));

    const rssMiB = process.memoryUsage().rss / 2 ** 20;
    console.log(`peak rss so far: ${rssMiB.toFixed(0)} MiB`);
    assert.ok(rssMiB < 512, `rss ${rssMiB} MiB exceeds 512 MiB`);
  },
);

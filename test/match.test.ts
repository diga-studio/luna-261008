import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distanceMiles } from "../src/geo.js";
import { compositeScore, roundScore } from "../src/scoring.js";
import { TalentBridge } from "../src/index.js";
import type { Candidate, Job, ZipCoordinate } from "../src/index.js";

const ALL_SLOTS = Array.from({ length: 14 }, (_, i) => i);

function expectedScore(
  jobSkills: number,
  commonSkills: number,
  dist: number,
  radius: number,
  commonSlots: number,
  jobSlots: number,
): number {
  const skillRatio = jobSkills === 0 ? 1 : commonSkills / jobSkills;
  const commuteRatio = 1 - dist / radius;
  const timeRatio = commonSlots / jobSlots;
  return roundScore(compositeScore(skillRatio, commuteRatio, timeRatio));
}

test("geo: haversine basics", () => {
  assert.equal(distanceMiles(40, -75, 40, -75), 0);
  // One degree of longitude on the equator.
  const d = distanceMiles(0, 0, 0, 1);
  assert.ok(Math.abs(d - (3958.7613 * Math.PI) / 180) < 1e-9);
  // Antimeridian: shortest path crosses 180°, not the long way around.
  const across = distanceMiles(10, 179.9, 10, -179.9);
  assert.ok(across > 13 && across < 14.2, `got ${across}`);
});

test("scoring: weights and 6-decimal rounding", () => {
  assert.equal(compositeScore(1, 1, 1), 100);
  assert.equal(compositeScore(0, 0, 0), 0);
  assert.equal(roundScore(80.1234567), 80.123457);
  assert.equal(roundScore(0.0000004), 0);
});

test("ranking: better skill/time match farther away beats the nearest job", () => {
  const zips: ZipCoordinate[] = [
    { zip: "Z0", lat: 0, lon: 0 },
    { zip: "Z1", lat: 0, lon: 0.1 }, // ~6.9 mi
    { zip: "Z2", lat: 0, lon: 0.5 }, // ~34.5 mi
  ];
  const jobs: Job[] = [
    { id: "J-near", zip: "Z1", skills: ["x", "y"], timeSlots: [0] },
    { id: "J-far", zip: "Z2", skills: ["a", "b", "c", "d", "e"], timeSlots: [0, 1] },
  ];
  const cands: Candidate[] = [
    { id: "C1", zip: "Z0", skills: ["a", "b", "c", "d", "e"], timeSlots: ALL_SLOTS, maxCommuteMiles: 50 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });

  const dNear = distanceMiles(0, 0, 0, 0.1);
  const dFar = distanceMiles(0, 0, 0, 0.5);
  const res = tb.recommendJobsForCandidate("C1");
  assert.deepEqual(
    res.map((r) => r.id),
    ["J-far", "J-near"],
  );
  assert.equal(res[0].score, expectedScore(5, 5, dFar, 50, 2, 2));
  assert.equal(res[1].score, expectedScore(2, 0, dNear, 50, 1, 1));
  assert.ok(res[0].score > res[1].score);
});

test("bidirectional: same pair score, and each candidate's own radius is used", () => {
  const zips: ZipCoordinate[] = [
    { zip: "Z0", lat: 0, lon: 0 },
    { zip: "Z1", lat: 0, lon: 0.1 },
    { zip: "Z2", lat: 0, lon: 0.5 },
  ];
  const jobs: Job[] = [
    { id: "J-far", zip: "Z2", skills: ["a", "b", "c", "d", "e"], timeSlots: [0, 1] },
  ];
  const cands: Candidate[] = [
    { id: "C1", zip: "Z0", skills: ["a", "b", "c", "d", "e"], timeSlots: ALL_SLOTS, maxCommuteMiles: 50 },
    // ~27.6 mi from J-far: outside a 5 mi radius, inside a 30 mi radius.
    { id: "C-too-small-radius", zip: "Z1", skills: ["a"], timeSlots: [0], maxCommuteMiles: 5 },
    { id: "C-mid", zip: "Z1", skills: ["a"], timeSlots: [0], maxCommuteMiles: 30 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });

  const forward = tb.recommendJobsForCandidate("C1");
  const reverse = tb.recommendCandidatesForJob("J-far");

  // Same pair, same score in both directions.
  const dFar = distanceMiles(0, 0, 0, 0.5);
  const expected = expectedScore(5, 5, dFar, 50, 2, 2);
  assert.equal(forward[0].score, expected);
  const c1 = reverse.find((r) => r.id === "C1");
  assert.ok(c1);
  assert.equal(c1.score, expected);

  // The 5-mile-radius candidate is excluded; the 30-mile one is scored with radius 30.
  assert.ok(!reverse.some((r) => r.id === "C-too-small-radius"));
  const cmid = reverse.find((r) => r.id === "C-mid");
  assert.ok(cmid);
  const dMid = distanceMiles(0, 0.1, 0, 0.5);
  assert.equal(cmid.score, expectedScore(5, 1, dMid, 30, 1, 2));
});

test("radius boundary: exactly at radius is included, just beyond is excluded", () => {
  // Place ZE2 so the equator distance from ZE1 is as close to 25 mi as float allows, <= 25.
  let lon = (25 / 3958.7613) * (180 / Math.PI);
  while (distanceMiles(0, 0, 0, lon) > 25) lon -= 1e-12;
  const d = distanceMiles(0, 0, 0, lon);
  assert.ok(d <= 25 && 25 - d < 1e-6, `boundary distance ${d}`);

  const zips: ZipCoordinate[] = [
    { zip: "ZE1", lat: 0, lon: 0 },
    { zip: "ZE2", lat: 0, lon },
  ];
  const jobs: Job[] = [{ id: "J-edge", zip: "ZE2", skills: ["a"], timeSlots: [0] }];
  const cands: Candidate[] = [
    { id: "C-in", zip: "ZE1", skills: ["a"], timeSlots: [0], maxCommuteMiles: 25 },
    { id: "C-out", zip: "ZE1", skills: ["a"], timeSlots: [0], maxCommuteMiles: 20 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });

  assert.deepEqual(tb.recommendJobsForCandidate("C-in").map((r) => r.id), ["J-edge"]);
  assert.deepEqual(tb.recommendJobsForCandidate("C-out"), []);

  const reverse = tb.recommendCandidatesForJob("J-edge").map((r) => r.id);
  assert.deepEqual(reverse, ["C-in"]);
});

test("antimeridian: pairs across 180° use the short way", () => {
  const zips: ZipCoordinate[] = [
    { zip: "ZA", lat: 10, lon: 179.9 },
    { zip: "ZB", lat: 10, lon: -179.9 },
  ];
  const jobs: Job[] = [{ id: "J-cross", zip: "ZA", skills: ["a"], timeSlots: [0] }];
  const cands: Candidate[] = [
    { id: "C-reach", zip: "ZB", skills: ["a"], timeSlots: [0], maxCommuteMiles: 15 },
    { id: "C-cannot", zip: "ZB", skills: ["a"], timeSlots: [0], maxCommuteMiles: 10 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });

  assert.deepEqual(tb.recommendJobsForCandidate("C-reach").map((r) => r.id), ["J-cross"]);
  assert.deepEqual(tb.recommendJobsForCandidate("C-cannot"), []);
  assert.deepEqual(
    tb.recommendCandidatesForJob("J-cross").map((r) => r.id),
    ["C-reach"],
  );
});

test("ties after rounding: truncation at 25 follows ASCII id order", () => {
  const zips: ZipCoordinate[] = [{ zip: "ZS", lat: 30, lon: 30 }];
  // 30 identical jobs, ids shuffled; all scores identical after rounding.
  const ids = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const shuffled = [...ids].reverse();
  const jobs: Job[] = shuffled.map((id) => ({ id, zip: "ZS", skills: [], timeSlots: [3] }));
  const cands: Candidate[] = [
    { id: "C1", zip: "ZS", skills: ["zzz"], timeSlots: [3], maxCommuteMiles: 5 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });

  const res = tb.recommendJobsForCandidate("C1");
  assert.equal(res.length, 25);
  assert.deepEqual(
    res.map((r) => r.id),
    ids.slice(0, 25),
  );
  for (const r of res) assert.equal(r.score, 100);

  // Same for the reverse direction with 30 identical candidates.
  const tb2 = new TalentBridge();
  tb2.loadData({
    jobs: [{ id: "J1", zip: "ZS", skills: [], timeSlots: [3] }],
    candidates: shuffled.map((id) => ({
      id,
      zip: "ZS",
      skills: [],
      timeSlots: [3],
      maxCommuteMiles: 5,
    })),
    zips,
  });
  const res2 = tb2.recommendCandidatesForJob("J1");
  assert.equal(res2.length, 25);
  assert.deepEqual(
    res2.map((r) => r.id),
    ids.slice(0, 25),
  );
});

test("determinism and error handling", () => {
  const zips: ZipCoordinate[] = [{ zip: "Z0", lat: 1, lon: 1 }];
  const jobs: Job[] = [{ id: "J1", zip: "Z0", skills: ["a"], timeSlots: [0] }];
  const cands: Candidate[] = [
    { id: "C1", zip: "Z0", skills: ["a"], timeSlots: [0], maxCommuteMiles: 5 },
  ];
  const tb = new TalentBridge();
  tb.loadData({ jobs, candidates: cands, zips });
  assert.deepEqual(tb.recommendJobsForCandidate("C1"), tb.recommendJobsForCandidate("C1"));
  assert.throws(() => tb.recommendJobsForCandidate("nope"));
  assert.throws(() => tb.recommendCandidatesForJob("nope"));
  assert.throws(() => new TalentBridge().recommendJobsForCandidate("C1"));
});

test("loadFromFiles reads JSON arrays and NDJSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "talentbridge-"));
  const zips: ZipCoordinate[] = [{ zip: "Z0", lat: 1, lon: 1 }];
  const jobs: Job[] = [{ id: "J1", zip: "Z0", skills: ["a"], timeSlots: [0] }];
  const cands: Candidate[] = [
    { id: "C1", zip: "Z0", skills: ["a"], timeSlots: [0], maxCommuteMiles: 5 },
  ];
  const jobsPath = join(dir, "jobs.json");
  const candsPath = join(dir, "candidates.ndjson");
  const zipsPath = join(dir, "zips.json");
  writeFileSync(jobsPath, JSON.stringify(jobs));
  writeFileSync(candsPath, cands.map((c) => JSON.stringify(c)).join("\n"));
  writeFileSync(zipsPath, JSON.stringify(zips));

  const tb = new TalentBridge();
  tb.loadFromFiles({ jobs: jobsPath, candidates: candsPath, zips: zipsPath });
  assert.deepEqual(tb.recommendJobsForCandidate("C1"), [{ id: "J1", score: 100 }]);
});

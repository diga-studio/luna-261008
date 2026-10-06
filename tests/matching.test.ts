import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TalentBridge,
  compositeScore,
  haversineMiles,
  round6,
} from '../src/index.js';
import type { Candidate, Job, ZipCoord } from '../src/index.js';

const DEG = Math.PI / 180;
const EARTH = 3958.7613;

function makeEngine(
  jobs: Job[],
  candidates: Candidate[],
  zipCodes: Record<string, ZipCoord>,
): TalentBridge {
  const tb = new TalentBridge();
  tb.load({ jobs, candidates, zipCodes });
  return tb;
}

test('farther job with better skills/schedule outranks the nearest job', () => {
  // Z_HOME -> Z_NEAR ~ 20.73 mi, Z_HOME -> Z_FAR ~ 41.46 mi.
  const zipCodes = {
    Z_HOME: { lat: 0, lon: 0 },
    Z_NEAR: { lat: 0, lon: 0.3 },
    Z_FAR: { lat: 0, lon: 0.6 },
  };
  const candidate: Candidate = {
    id: 'C1',
    zip: 'Z_HOME',
    skills: ['k1', 'k2', 'k3', 'k4'],
    slots: [0, 1, 2, 3, 4, 5, 6],
    maxCommuteMiles: 50,
  };
  const jobs: Job[] = [
    // Nearest, but zero skill overlap and zero slot overlap.
    { id: 'J_NEAR', zip: 'Z_NEAR', skills: ['x1', 'x2'], slots: [7, 8, 9] },
    // Twice as far, but perfect skill and slot match.
    { id: 'J_FAR', zip: 'Z_FAR', skills: ['k1', 'k2', 'k3', 'k4'], slots: [0, 1, 2, 3, 4, 5, 6] },
  ];
  const tb = makeEngine(jobs, [candidate], zipCodes);
  const result = tb.recommendJobs('C1');
  assert.deepEqual(
    result.map((r) => r.jobId),
    ['J_FAR', 'J_NEAR'],
  );
  const dNear = haversineMiles(0, 0, 0, 0.3);
  const dFar = haversineMiles(0, 0, 0, 0.6);
  assert.equal(result[0].score, round6(compositeScore(1, 1 - dFar / 50, 1)));
  assert.equal(result[1].score, round6(compositeScore(0, 1 - dNear / 50, 0)));
});

test('reverse recommendations apply each candidate\'s own radius', () => {
  const zipCodes = {
    Z_HOME: { lat: 0, lon: 0 },
    Z_NEAR: { lat: 0, lon: 0.3 },
    Z_FAR: { lat: 0, lon: 0.6 },
  };
  const job: Job = { id: 'JQ', zip: 'Z_HOME', skills: ['k1', 'k2'], slots: [0, 1] };
  const candidates: Candidate[] = [
    // Same zip as C_CLOSE_BIG but a 5-mile radius: 20.7 mi away => excluded.
    { id: 'C_CLOSE_SMALL', zip: 'Z_NEAR', skills: ['k1', 'k2'], slots: [0, 1], maxCommuteMiles: 5 },
    // 20.7 mi away, radius 25 => included with commute ratio 1 - d/25.
    { id: 'C_CLOSE_BIG', zip: 'Z_NEAR', skills: ['k1'], slots: [0], maxCommuteMiles: 25 },
    // 41.5 mi away, radius 50 => included with commute ratio 1 - d/50.
    { id: 'C_FAR_BIG', zip: 'Z_FAR', skills: ['k1', 'k2'], slots: [0, 1], maxCommuteMiles: 50 },
  ];
  const tb = makeEngine([job], candidates, zipCodes);
  const result = tb.recommendCandidates('JQ');
  assert.deepEqual(
    result.map((r) => r.candidateId),
    ['C_FAR_BIG', 'C_CLOSE_BIG'],
  );
  const dNear = haversineMiles(0, 0, 0, 0.3);
  const dFar = haversineMiles(0, 0, 0, 0.6);
  assert.equal(result[0].score, round6(compositeScore(1, 1 - dFar / 50, 1)));
  assert.equal(result[1].score, round6(compositeScore(0.5, 1 - dNear / 25, 0.5)));

  // The pair score is identical in both directions and uses the candidate's radius.
  const forward = tb.recommendJobs('C_FAR_BIG');
  assert.deepEqual(forward, [{ jobId: 'JQ', score: result[0].score }]);
});

test('pairs across the 180th meridian are matched by short-way distance', () => {
  // ~6.8 miles apart across the antimeridian.
  const zipCodes = {
    Z_A: { lat: 10, lon: 179.95 },
    Z_B: { lat: 10, lon: -179.95 },
  };
  const job: Job = { id: 'J_ACROSS', zip: 'Z_B', skills: ['s1'], slots: [0] };
  const candidates: Candidate[] = [
    { id: 'C_TOO_FAR', zip: 'Z_A', skills: ['s1'], slots: [0], maxCommuteMiles: 5 },
    { id: 'C_IN_RANGE', zip: 'Z_A', skills: ['s1'], slots: [0], maxCommuteMiles: 10 },
  ];
  const tb = makeEngine([job], candidates, zipCodes);
  const d = haversineMiles(10, 179.95, 10, -179.95);
  assert.ok(d > 5 && d < 10, `precondition: distance ${d} in (5, 10)`);

  const result = tb.recommendCandidates('J_ACROSS');
  assert.deepEqual(result.map((r) => r.candidateId), ['C_IN_RANGE']);
  assert.equal(result[0].score, round6(compositeScore(1, 1 - d / 10, 1)));

  // Forward direction agrees.
  assert.deepEqual(tb.recommendJobs('C_TOO_FAR'), []);
  assert.equal(tb.recommendJobs('C_IN_RANGE')[0].jobId, 'J_ACROSS');
});

test('a pair exactly on the commute-radius boundary is included', () => {
  // Longitude offset whose great-circle distance from (0,0) is exactly 5.0 miles.
  const lon5 = 5 / EARTH / DEG;
  assert.equal(haversineMiles(0, 0, 0, lon5), 5, 'precondition: exact 5.0 miles');
  const zipCodes = {
    Z_E: { lat: 0, lon: 0 },
    Z_ON: { lat: 0, lon: lon5 },
    Z_OFF: { lat: 0, lon: lon5 + 1e-12 },
  };
  const candidate: Candidate = {
    id: 'C_B',
    zip: 'Z_E',
    skills: ['s1'],
    slots: [0],
    maxCommuteMiles: 5,
  };
  const jobs: Job[] = [
    { id: 'J_ON', zip: 'Z_ON', skills: ['s1'], slots: [0] },
    { id: 'J_OFF', zip: 'Z_OFF', skills: ['s1'], slots: [0] },
  ];
  const tb = makeEngine(jobs, [candidate], zipCodes);
  assert.ok(haversineMiles(0, 0, 0, lon5 + 1e-12) > 5, 'precondition: just outside');
  const result = tb.recommendJobs('C_B');
  assert.deepEqual(result.map((r) => r.jobId), ['J_ON']);
  // Boundary pair: commute ratio is exactly 0, score comes from skills+slots.
  assert.equal(result[0].score, round6(compositeScore(1, 0, 1)));
});

test('more than 25 rounded-score ties truncate in ascending id order', () => {
  const zipCodes = { Z_T: { lat: 5, lon: 5 } };
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push(`tie-${String(i).padStart(2, '0')}`);
  // Insert in scrambled order; ranking must not depend on insertion order.
  const scrambled = [...ids].sort(() => (Math.random() < 0.5 ? -1 : 1));
  const jobs: Job[] = scrambled.map((id) => ({
    id,
    zip: 'Z_T',
    skills: ['t1', 't2'],
    slots: [0, 1, 2],
  }));
  const candidate: Candidate = {
    id: 'C_T',
    zip: 'Z_T',
    skills: ['t1'],
    slots: [0],
    maxCommuteMiles: 5,
  };
  const tb = makeEngine(jobs, [candidate], zipCodes);
  const result = tb.recommendJobs('C_T');
  assert.equal(result.length, 25);
  assert.deepEqual(
    result.map((r) => r.jobId),
    ids.slice(0, 25),
  );
  const expectedScore = round6(compositeScore(0.5, 1, 1 / 3));
  for (const r of result) assert.equal(r.score, expectedScore);
});

test('scores that differ below 1e-6 rank as ties and break by id', () => {
  // Find a longitude offset where two jobs have different raw scores that
  // round to the same 6-decimal value.
  const skills = ['r1'];
  const slots = [0];
  const rawScore = (lon: number): number => {
    const d = haversineMiles(0, 0, 0, lon);
    return compositeScore(1, 1 - d / 50, 1);
  };
  const lon1 = 0.1;
  let lon2 = 0;
  for (let k = 1; k < 100000; k++) {
    const candidate2 = lon1 + k * 1e-9;
    if (rawScore(candidate2) !== rawScore(lon1) && round6(rawScore(candidate2)) === round6(rawScore(lon1))) {
      lon2 = candidate2;
      break;
    }
  }
  assert.ok(lon2 !== 0, 'precondition: found a rounding-tie longitude');
  const zipCodes = {
    Z_R: { lat: 0, lon: 0 },
    Z_1: { lat: 0, lon: lon1 },
    Z_2: { lat: 0, lon: lon2 },
    Z_3: { lat: 0, lon: 0.2 },
  };
  const candidate: Candidate = {
    id: 'C_R',
    zip: 'Z_R',
    skills,
    slots,
    maxCommuteMiles: 50,
  };
  const jobs: Job[] = [
    { id: 'JR_B', zip: 'Z_2', skills, slots },
    { id: 'JR_A', zip: 'Z_1', skills, slots },
    { id: 'JR_C', zip: 'Z_3', skills, slots },
  ];
  const tb = makeEngine(jobs, [candidate], zipCodes);
  const result = tb.recommendJobs('C_R');
  assert.equal(result.length, 3);
  assert.equal(result[0].score, result[1].score, 'rounded scores tie');
  assert.deepEqual(
    result.map((r) => r.jobId),
    ['JR_A', 'JR_B', 'JR_C'],
    'ties break by ascending id; strictly lower score last',
  );
  assert.ok(result[1].score > result[2].score);
});

test('unknown ids and missing load throw', () => {
  const tb = new TalentBridge();
  assert.throws(() => tb.recommendJobs('nope'), /load/);
  const engine = makeEngine(
    [{ id: 'J', zip: 'Z', skills: [], slots: [0] }],
    [{ id: 'C', zip: 'Z', skills: [], slots: [], maxCommuteMiles: 5 }],
    { Z: { lat: 0, lon: 0 } },
  );
  assert.throws(() => engine.recommendJobs('nope'), /Unknown candidate/);
  assert.throws(() => engine.recommendCandidates('nope'), /Unknown job/);
});

test('job with no required skills gets skill ratio 1', () => {
  const zipCodes = { Z: { lat: 0, lon: 0 } };
  const tb = makeEngine(
    [{ id: 'J', zip: 'Z', skills: [], slots: [0, 1] }],
    [{ id: 'C', zip: 'Z', skills: ['s1'], slots: [0], maxCommuteMiles: 5 }],
    zipCodes,
  );
  const result = tb.recommendJobs('C');
  assert.equal(result[0].score, round6(compositeScore(1, 1, 0.5)));
});

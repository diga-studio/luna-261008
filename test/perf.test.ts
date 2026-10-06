import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { ScheduleEngine } from '../src/engine';
import { SessionInput } from '../src/types';

/**
 * 规模测试：10 万场次、30 万条报名，集中在少数热点资源上
 * （20 名教师各 5000 场、10 个场地各 10000 场、3000 名学员各 100 场）。
 * 造数过程不计时；随后反复执行小批次调期与报名增删并记录耗时。
 */
const SESSIONS = 100_000;
const INSTRUCTORS = 20;
const VENUES = 10;
const TRAINEE_LANES = 3;
const TRAINEES_PER_LANE = 1000;
const DURATION = 60;
const SLOT = 600; // 场地日历稀疏，给调期留出空档
const ROUNDS = 500;

function buildSession(j: number): SessionInput {
  return {
    id: `S${j}`,
    instructorId: `I${j % INSTRUCTORS}`,
    venueId: `V${j % VENUES}`,
    start: Math.floor(j / VENUES) * SLOT,
    end: Math.floor(j / VENUES) * SLOT + DURATION,
    capacity: 50,
  };
}

function laneTrainee(lane: number, j: number): string {
  return `T${lane}_${j % TRAINEES_PER_LANE}`;
}

test('scale: 100k sessions / 300k enrollments with hot resources', { timeout: 300_000 }, () => {
  const engine = new ScheduleEngine();

  // ---- 造数（不计时）----
  for (let base = 0; base < SESSIONS; base += 200) {
    const batch: SessionInput[] = [];
    for (let j = base; j < base + 200; j += 1) batch.push(buildSession(j));
    const result = engine.applyScheduleBatch(batch);
    assert.ok(result.ok, 'initial batch should succeed');
  }
  for (let j = 0; j < SESSIONS; j += 1) {
    for (let lane = 0; lane < TRAINEE_LANES; lane += 1) {
      const result = engine.setEnrollment(`S${j}`, laneTrainee(lane, j), true);
      assert.ok(result.ok, `initial enrollment should succeed at S${j}`);
    }
  }
  assert.equal(engine.getSession('S0')?.trainees.length, TRAINEE_LANES);

  // ---- 操作循环（计时）----
  let batchNanos = 0;
  let enrollNanos = 0;
  let batchCount = 0;
  let enrollCount = 0;
  let batchFailures = 0;
  let enrollFailures = 0;

  // 简单的确定性伪随机数，避免测试间波动。
  let seed = 0x9e3779b9;
  const nextRandom = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };

  for (let round = 0; round < ROUNDS; round += 1) {
    // 小批次调期：随机 5 个场次平移时间（可能失败，走完整诊断路径）。
    const changes: SessionInput[] = [];
    for (let k = 0; k < 5; k += 1) {
      const j = Math.floor(nextRandom() * SESSIONS);
      const shift = (Math.floor(nextRandom() * 21) - 10) * DURATION;
      const original = buildSession(j);
      changes.push({ ...original, start: original.start + shift, end: original.end + shift });
    }
    let started = performance.now();
    const batchResult = engine.applyScheduleBatch(changes);
    batchNanos += performance.now() - started;
    batchCount += 1;
    if (!batchResult.ok) batchFailures += 1;

    // 报名增删：删除构造时生成的学员，再加入全新学员。
    for (let k = 0; k < 5; k += 1) {
      const j = Math.floor(nextRandom() * SESSIONS);
      const lane = Math.floor(nextRandom() * TRAINEE_LANES);
      started = performance.now();
      const removed = engine.setEnrollment(`S${j}`, laneTrainee(lane, j), false);
      enrollNanos += performance.now() - started;
      enrollCount += 1;
      if (!removed.ok) enrollFailures += 1;

      started = performance.now();
      const added = engine.setEnrollment(`S${j}`, `P${round}_${k}`, true);
      enrollNanos += performance.now() - started;
      enrollCount += 1;
      if (!added.ok) enrollFailures += 1;
    }
  }

  const batchMs = batchNanos;
  const enrollMs = enrollNanos;
  console.log(
    `[perf] ${batchCount} batches (5 sessions each): total ${batchMs.toFixed(1)}ms, ` +
      `avg ${(batchMs / batchCount).toFixed(3)}ms, failures ${batchFailures}`,
  );
  console.log(
    `[perf] ${enrollCount} enrollment ops: total ${enrollMs.toFixed(1)}ms, ` +
      `avg ${(enrollMs / enrollCount).toFixed(4)}ms, failures ${enrollFailures}`,
  );

  // 宽松的性能上限，防止复杂度退化（正常应远低于此）。
  assert.ok(batchMs / batchCount < 20, `batch avg too slow: ${batchMs / batchCount}ms`);
  assert.ok(enrollMs / enrollCount < 2, `enroll avg too slow: ${enrollMs / enrollCount}ms`);

  // ---- 操作后索引仍然一致 ----
  // 热点教师 I0 的日历里找一个确定被占用的区间，必须报冲突；
  // 遥远的空闲区间必须可以排课。
  const sample = engine.getSession('S0');
  assert.ok(sample !== undefined);
  const probe = engine.applyScheduleBatch([
    {
      id: 'PROBE',
      instructorId: sample.instructorId,
      venueId: 'V_PROBE',
      start: sample.start,
      end: sample.end,
      capacity: 1,
    },
  ]);
  assert.equal(probe.ok, false, 'probe overlapping S0 instructor must conflict');
  const far = engine.applyScheduleBatch([
    {
      id: 'FAR',
      instructorId: sample.instructorId,
      venueId: sample.venueId,
      start: Number.MAX_SAFE_INTEGER - 120,
      end: Number.MAX_SAFE_INTEGER - 60,
      capacity: 1,
    },
  ]);
  assert.ok(far.ok, 'far-future slot must be free');
});

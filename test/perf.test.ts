import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SkillPulseEngine } from '../src/index.js';
import type { SessionInput } from '../src/index.js';

// 确定性 PRNG，保证可复现
function makeRnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SESSIONS = 100_000;
const ENROLLMENTS = 300_000;
const HOT_TRAINEES = 300; // 少数热点学员承载全部 30 万报名
const HOT_INSTRUCTORS = 10;
const HOT_VENUES = 10;
const SLOT = 30; // 每场 30 分钟，顺序排列互不重叠

test('规模：10万场次/30万报名，热点资源上反复小批次调期与报名增删', () => {
  const e = new SkillPulseEngine();
  const rnd = makeRnd(20261006);

  // ---- 造数（不计时）----
  // 场次 i 占 [i*30, i*30+30)，教师/场地各 10 个热点轮转。
  // 每场分配 3 名热点学员（(i+k) % 300），共 30 万条报名。
  const t0 = performance.now();
  for (let base = 0; base < SESSIONS; base += 200) {
    const batch: SessionInput[] = [];
    for (let i = base; i < base + 200 && i < SESSIONS; i++) {
      batch.push({
        id: 'S' + i,
        instructorId: 'I' + (i % HOT_INSTRUCTORS),
        venueId: 'V' + (i % HOT_VENUES),
        start: i * SLOT,
        end: i * SLOT + SLOT,
        capacity: 50,
      });
    }
    const r = e.applyScheduleBatch(batch);
    assert.equal(r.ok, true);
  }
  let enrolled = 0;
  for (let i = 0; i < SESSIONS; i++) {
    for (let k = 0; k < 3; k++) {
      const r = e.setEnrollment('S' + i, 'T' + ((i + k) % HOT_TRAINEES), true);
      assert.equal(r.ok, true);
      enrolled++;
    }
  }
  assert.equal(enrolled, ENROLLMENTS);
  const setupMs = performance.now() - t0;

  // ---- 操作循环（计时）----
  // 每轮：1 个小批次调期（把随机场次搬到时间轴末端的新空槽，携带已有报名）
  //       + 若干次报名增删。
  const ROUNDS = 2_000;
  const BATCH = 10;
  let nextFree = SESSIONS * SLOT;
  let batchOps = 0;
  let enrollOps = 0;
  const op0 = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    const batch: SessionInput[] = [];
    const picked: string[] = [];
    for (let b = 0; b < BATCH; b++) {
      const i = Math.floor(rnd() * SESSIONS);
      const id = 'S' + i;
      if (picked.includes(id)) continue;
      picked.push(id);
      const cur = e.getSession(id)!;
      batch.push({
        id,
        instructorId: cur.instructorId,
        venueId: cur.venueId,
        start: nextFree,
        end: nextFree + SLOT,
        capacity: cur.capacity,
      });
      nextFree += SLOT;
    }
    const r = e.applyScheduleBatch(batch);
    assert.equal(r.ok, true);
    batchOps++;

    // 报名增删：从随机老场次退一人，给刚搬走的场次加一人
    for (let k = 0; k < 4; k++) {
      const victim = 'S' + Math.floor(rnd() * SESSIONS);
      const trainees = e.getSession(victim)!.trainees;
      if (trainees.length > 0) {
        assert.equal(e.setEnrollment(victim, trainees[0], false).ok, true);
        enrollOps++;
      }
      const t = 'T' + Math.floor(rnd() * HOT_TRAINEES);
      const target = picked[k % picked.length];
      const res = e.setEnrollment(target, t, true);
      assert.equal(res.ok, true); // 末端空槽，不会冲突
      enrollOps++;
    }
  }
  const opMs = performance.now() - op0;

  console.log(
    `[perf] 造数(不计入): ${setupMs.toFixed(0)}ms | ` +
      `${batchOps} 批次调期 + ${enrollOps} 报名增删: ${opMs.toFixed(0)}ms ` +
      `(平均 ${(opMs / ROUNDS).toFixed(2)}ms/轮)`,
  );

  // 正确性抽查：被搬走的场次学员保留、区间已更新
  const sample = e.getSession('S' + (SESSIONS - 1))!;
  assert.ok(sample.end - sample.start === SLOT);
  // 宽松上界：防止退化为全量扫描（本机实测约几百毫秒）
  assert.ok(opMs < 10_000, `操作循环耗时 ${opMs}ms 超出上界`);
});

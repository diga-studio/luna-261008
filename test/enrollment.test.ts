import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillPulseEngine } from '../src/index.js';
import type { SessionInput } from '../src/index.js';

function s(id: string, start: number, end: number, over: Partial<SessionInput> = {}): SessionInput {
  return { id, instructorId: 'I-' + id, venueId: 'V-' + id, start, end, capacity: 10, ...over };
}

test('重复加入与重复退出均为空操作', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([s('A', 0, 60)]);
  assert.deepEqual(e.setEnrollment('A', 'T1', true), { ok: true });
  assert.deepEqual(e.setEnrollment('A', 'T1', true), { ok: true }); // 重复加入
  assert.deepEqual(e.getSession('A')!.trainees, ['T1']);
  assert.deepEqual(e.setEnrollment('A', 'T1', false), { ok: true });
  assert.deepEqual(e.setEnrollment('A', 'T1', false), { ok: true }); // 重复退出
  assert.deepEqual(e.getSession('A')!.trainees, []);
  // 未报名过的学员退出也是空操作
  assert.deepEqual(e.setEnrollment('A', 'T9', false), { ok: true });
});

test('未知场次抛错；getSession 对未知 id 返回 undefined', () => {
  const e = new SkillPulseEngine();
  assert.throws(() => e.setEnrollment('NOPE', 'T1', true));
  assert.throws(() => e.setEnrollment('NOPE', 'T1', false));
  assert.equal(e.getSession('NOPE'), undefined);
});

test('加入失败：报告该学员的所有时间冲突与容量问题', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([
    s('A', 0, 100),
    s('B', 100, 200),
    s('C', 200, 300),
    s('D', 500, 600), // 与学员无关
    s('E', 50, 250, { capacity: 1 }), // 与 A、B、C 均重叠
  ]);
  // T1 已在 A、B、C
  e.setEnrollment('A', 'T1', true);
  e.setEnrollment('B', 'T1', true);
  e.setEnrollment('C', 'T1', true);
  // E 已满
  e.setEnrollment('E', 'OTHER', true);

  // T1 加入 E：与 A、B、C 均重叠 + E 容量不足，四项诊断一次返回
  const r = e.setEnrollment('E', 'T1', true);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.report.overlaps, [
    { sessionIds: ['A', 'E'], resources: [{ kind: 'trainee', id: 'T1' }] },
    { sessionIds: ['B', 'E'], resources: [{ kind: 'trainee', id: 'T1' }] },
    { sessionIds: ['C', 'E'], resources: [{ kind: 'trainee', id: 'T1' }] },
  ]);
  assert.deepEqual(r.report.capacityViolations, [
    { sessionId: 'E', capacity: 1, enrolled: 2 },
  ]);
  // 失败后状态未变
  assert.deepEqual(e.getSession('E')!.trainees, ['OTHER']);
});

test('容量满后退出一人即可再加入', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([s('A', 0, 60, { capacity: 1 })]);
  e.setEnrollment('A', 'T1', true);
  assert.equal(e.setEnrollment('A', 'T2', true).ok, false);
  e.setEnrollment('A', 'T1', false);
  assert.deepEqual(e.setEnrollment('A', 'T2', true), { ok: true });
  assert.deepEqual(e.getSession('A')!.trainees, ['T2']);
});

test('getSession 返回快照，调用方修改不影响引擎', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([s('A', 0, 60)]);
  e.setEnrollment('A', 'T1', true);
  const snap = e.getSession('A')!;
  snap.trainees.push('HACK');
  snap.start = 999;
  const again = e.getSession('A')!;
  assert.deepEqual(again.trainees, ['T1']);
  assert.equal(again.start, 0);
});

test('学员冲突只针对本人，不影响其他学员', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([s('A', 0, 100), s('B', 50, 150)]);
  e.setEnrollment('A', 'T1', true);
  // T2 可以同时加入 A 和 B（学员不同，不冲突）
  assert.deepEqual(e.setEnrollment('B', 'T2', true), { ok: true });
  // T1 加入 B 冲突
  assert.equal(e.setEnrollment('B', 'T1', true).ok, false);
});

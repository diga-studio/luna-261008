import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillPulseEngine } from '../src/index.js';
import type { SessionInput } from '../src/index.js';

function s(id: string, start: number, end: number, over: Partial<SessionInput> = {}): SessionInput {
  return { id, instructorId: 'I-' + id, venueId: 'V-' + id, start, end, capacity: 10, ...over };
}

test('两场次批量交换时间成功', () => {
  const e = new SkillPulseEngine();
  // A、B 共用教师 I1；C、D 共用教师 I2。交换 A<->C 的时间后仍合法。
  assert.deepEqual(e.applyScheduleBatch([
    s('A', 0, 60, { instructorId: 'I1' }),
    s('B', 60, 120, { instructorId: 'I1' }),
    s('C', 200, 260, { instructorId: 'I2' }),
    s('D', 260, 320, { instructorId: 'I2' }),
  ]), { ok: true });

  // 交换 A 与 C 的时间：A->[200,260), C->[0,60)。中间状态若逐条保存会冲突，整批判断应通过。
  const r = e.applyScheduleBatch([
    s('A', 200, 260, { instructorId: 'I1' }),
    s('C', 0, 60, { instructorId: 'I2' }),
  ]);
  assert.deepEqual(r, { ok: true });
  assert.equal(e.getSession('A')!.start, 200);
  assert.equal(e.getSession('C')!.start, 0);
});

test('交换场地：同一场地两批次内场次互换，不因中间状态拒绝', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([
    s('A', 0, 60, { venueId: 'V1' }),
    s('B', 0, 60, { venueId: 'V2' }),
  ]);
  const r = e.applyScheduleBatch([
    s('A', 0, 60, { venueId: 'V2' }),
    s('B', 0, 60, { venueId: 'V1' }),
  ]);
  assert.deepEqual(r, { ok: true });
  assert.equal(e.getSession('A')!.venueId, 'V2');
  assert.equal(e.getSession('B')!.venueId, 'V1');
});

test('批次中一项容量不足则整批失败，且无残留索引变更', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([
    s('A', 0, 60, { instructorId: 'I1' }),
    s('B', 60, 120, { instructorId: 'I1' }),
    s('C', 200, 260, { instructorId: 'I2', capacity: 1 }),
  ]);
  // C 已有 1 名学员（满员）
  assert.deepEqual(e.setEnrollment('C', 'T1', true), { ok: true });

  // 交换 A/C 时间（本身合法），同时把 C 的 capacity 改为 0 人容不下的……
  // capacity 最小为 1，改为把 B 换成 capacity 1 且先给 B 加两名学员更直接：
  e.applyScheduleBatch([s('B', 60, 120, { instructorId: 'I1', capacity: 2 })]);
  e.setEnrollment('B', 'U1', true);
  e.setEnrollment('B', 'U2', true);

  const before = {
    A: e.getSession('A'),
    B: e.getSession('B'),
    C: e.getSession('C'),
  };
  // 批次：A/C 交换时间（合法）+ B 缩容到 1（已有 2 名学员，违规）
  const r = e.applyScheduleBatch([
    s('A', 200, 260, { instructorId: 'I1' }),
    s('C', 0, 60, { instructorId: 'I2', capacity: 1 }),
    s('B', 60, 120, { instructorId: 'I1', capacity: 1 }),
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.report.capacityViolations, [
      { sessionId: 'B', capacity: 1, enrolled: 2 },
    ]);
    assert.deepEqual(r.report.overlaps, []);
  }
  // 状态完全保持
  assert.deepEqual(e.getSession('A'), before.A);
  assert.deepEqual(e.getSession('B'), before.B);
  assert.deepEqual(e.getSession('C'), before.C);
  // 后续报名证明索引无残留：
  e.applyScheduleBatch([s('X', 30, 90, { capacity: 5 }), s('Y', 200, 220, { capacity: 5 })]);
  assert.deepEqual(e.setEnrollment('A', 'W1', true), { ok: true }); // A 仍在 [0,60)
  // X[30,90) 与 A[0,60) 重叠 -> 必须报 A-X 冲突（证明 A 的索引未被失败批次改动）
  const erX = e.setEnrollment('X', 'W1', true);
  assert.equal(erX.ok, false);
  if (!erX.ok) {
    assert.deepEqual(erX.report.overlaps, [
      { sessionIds: ['A', 'X'], resources: [{ kind: 'trainee', id: 'W1' }] },
    ]);
  }
  // 若 A 被错误移到 [200,260)，加入 Y 会误报冲突；正确应为成功
  assert.deepEqual(e.setEnrollment('Y', 'W1', true), { ok: true });
  // 加入 B[60,120)：与 A[0,60) 首尾相接不算冲突，但 B 已满（U1、U2）-> 报容量违规
  const erB = e.setEnrollment('B', 'W1', true);
  assert.equal(erB.ok, false);
  if (!erB.ok) {
    assert.deepEqual(erB.report.overlaps, []);
    assert.deepEqual(erB.report.capacityViolations, [
      { sessionId: 'B', capacity: 2, enrolled: 3 },
    ]);
  }
  // 再验证退出：从 A 退出后加入 X 应成功（证明学员索引随退出即时更新）
  assert.deepEqual(e.setEnrollment('A', 'W1', false), { ok: true });
  assert.deepEqual(e.setEnrollment('X', 'W1', true), { ok: true });
});

test('长区间覆盖多个短区间：完整诊断、共享多资源、首尾相接不算重叠', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([
    // 未修改场次
    s('S1', 100, 140, { instructorId: 'I1', venueId: 'V1' }),
    s('S2', 150, 180, { instructorId: 'I2', venueId: 'V2' }),
    // 与 LONG 新区间首尾相接，不算重叠
    s('S3', 60, 100, { instructorId: 'I1', venueId: 'V1' }),
    s('S4', 240, 300, { instructorId: 'I1', venueId: 'V1' }),
    // 批次内另一场次
    s('M1', 170, 190, { instructorId: 'I3', venueId: 'V3' }),
    // LONG 原本在远处，本批将被移到 [100,240)
    s('LONG', 400, 460, { instructorId: 'I1', venueId: 'V1' }),
  ]);
  e.setEnrollment('S1', 'T1', true);
  e.setEnrollment('S1', 'T2', true);
  e.setEnrollment('M1', 'T1', true);
  e.setEnrollment('LONG', 'T1', true);
  e.setEnrollment('LONG', 'T2', true);

  // LONG 移到 [100,240) 覆盖 S1、S2、M1；M1 同批改教师为 I1
  const r = e.applyScheduleBatch([
    s('LONG', 100, 240, { instructorId: 'I1', venueId: 'V1' }),
    s('M1', 170, 190, { instructorId: 'I1', venueId: 'V9' }),
  ]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.report.capacityViolations, []);
  // 按 (场次1, 场次2) 字典序：['LONG','M1'] 在 ['LONG','S1'] 前
  assert.deepEqual(r.report.overlaps, [
    {
      sessionIds: ['LONG', 'M1'],
      resources: [
        { kind: 'instructor', id: 'I1' },
        { kind: 'trainee', id: 'T1' },
      ],
    },
    {
      sessionIds: ['LONG', 'S1'],
      resources: [
        { kind: 'instructor', id: 'I1' },
        { kind: 'venue', id: 'V1' },
        { kind: 'trainee', id: 'T1' },
        { kind: 'trainee', id: 'T2' },
      ],
    },
    // LONG 与 S2 只共享时间，无共享资源 -> 不出现
    // S3/S4 与 LONG 首尾相接 -> 不出现
  ]);
  // 失败后 LONG 仍在原区间 [400,460)
  assert.equal(e.getSession('LONG')!.start, 400);
});

test('替换保留已确认学员；旧区间不再参与冲突判断', () => {
  const e = new SkillPulseEngine();
  e.applyScheduleBatch([s('A', 0, 100, { instructorId: 'I1' })]);
  e.setEnrollment('A', 'T1', true);
  // 把 A 改到 [500, 560)：旧区间 [0,100) 不得再引发冲突
  const r = e.applyScheduleBatch([s('A', 500, 560, { instructorId: 'I1' })]);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(e.getSession('A')!.trainees, ['T1']);
  // 学员 T1 现在可以加入 [0,100) 的场次（A 已移走）
  e.applyScheduleBatch([s('B', 0, 100, { capacity: 5 })]);
  assert.deepEqual(e.setEnrollment('B', 'T1', true), { ok: true });
  // 但不能加入与 A 新区间重叠的场次
  e.applyScheduleBatch([s('C', 520, 600, { capacity: 5 })]);
  const er = e.setEnrollment('C', 'T1', true);
  assert.equal(er.ok, false);
  if (!er.ok) {
    assert.deepEqual(er.report.overlaps, [
      { sessionIds: ['A', 'C'], resources: [{ kind: 'trainee', id: 'T1' }] },
    ]);
  }
});

test('输入校验：重复 id、非法区间、非法 capacity、超大批量', () => {
  const e = new SkillPulseEngine();
  assert.throws(() => e.applyScheduleBatch([s('A', 0, 10), s('A', 20, 30)]));
  assert.throws(() => e.applyScheduleBatch([s('A', 10, 10)]));
  assert.throws(() => e.applyScheduleBatch([s('A', 0, 10, { capacity: 0 })]));
  assert.throws(() => e.applyScheduleBatch([s('A', 0, 10, { capacity: 51 })]));
  assert.throws(() =>
    e.applyScheduleBatch(Array.from({ length: 201 }, (_, i) => s('S' + i, i * 10, i * 10 + 5))),
  );
  // 校验失败不污染状态
  assert.equal(e.getSession('A'), undefined);
});

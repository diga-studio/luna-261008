import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditModule } from '../src/index.js';
import { RefProject, assertSnapshotEquals, diamondSpec } from './helpers.js';

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  return join(dir, 'test.db');
}

test('成功请求重放：项目继续变化后仍返回原结果，不二次改状态', () => {
  const db = freshDb();
  const m = new AuditModule(db);
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);

  const sub = m.submitReview('p', { requestKey: 'k-sub', stepId: 'A', expectedVersion: 0, text: 'v1文本' });
  assert.equal(sub.kind, 'ok');
  ref.submit('k-sub', 'A', 0, 'v1文本');
  const sign = m.signOff('p', { requestKey: 'k-sign', stepId: 'A', expectedVersion: 1 });
  assert.equal(sign.kind, 'ok');
  ref.signoff('k-sign', 'A', 1);

  const replaySub = m.submitReview('p', { requestKey: 'k-sub', stepId: 'A', expectedVersion: 0, text: 'v1文本' });
  assert.deepEqual(replaySub, sub, '重放返回原结果');
  const replaySign = m.signOff('p', { requestKey: 'k-sign', stepId: 'A', expectedVersion: 1 });
  assert.deepEqual(replaySign, sign);
  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());

  const rw = m.rework('p', { requestKey: 'k-rw', stepId: 'A', expectedVersion: 2 });
  assert.equal(rw.kind, 'ok');
  ref.rework('k-rw', 'A', 2);
  const afterRework = m.getSnapshot('p');

  const replayRw = m.rework('p', { requestKey: 'k-rw', stepId: 'A', expectedVersion: 2 });
  assert.deepEqual(replayRw, rw, '返工重放返回原结果');
  assert.deepEqual(m.getSnapshot('p'), afterRework, '没有二次撤销、版本不再增加');

  const replayOld = m.submitReview('p', { requestKey: 'k-sub', stepId: 'A', expectedVersion: 0, text: 'v1文本' });
  assert.deepEqual(replayOld, sub, '项目变化后重放仍返回原结果（优先于版本检查）');
  assert.deepEqual(m.getSnapshot('p'), afterRework);
  m.close();
});

test('重开后重放：返回原结果且不重复生效', () => {
  const db = freshDb();
  const spec = diamondSpec('p');
  const m1 = new AuditModule(db);
  m1.initProject(spec);
  m1.submitReview('p', { requestKey: 'p1', stepId: 'A', expectedVersion: 0 });
  m1.signOff('p', { requestKey: 'p2', stepId: 'A', expectedVersion: 1 });
  m1.submitReview('p', { requestKey: 'p3', stepId: 'B', expectedVersion: 0 });
  m1.signOff('p', { requestKey: 'p4', stepId: 'B', expectedVersion: 1 });
  const rw = m1.rework('p', { requestKey: 'p5', stepId: 'A', expectedVersion: 2 });
  assert.equal(rw.kind, 'ok');
  const before = m1.getSnapshot('p');
  m1.close();

  const m2 = new AuditModule(db);
  assert.deepEqual(m2.getSnapshot('p'), before, '重开后状态保留');
  const replay = m2.rework('p', { requestKey: 'p5', stepId: 'A', expectedVersion: 2 });
  assert.deepEqual(replay, rw, '重开后重放返回原结果');
  assert.deepEqual(m2.getSnapshot('p'), before, '没有二次撤销');
  const replaySign = m2.signOff('p', { requestKey: 'p4', stepId: 'B', expectedVersion: 1 });
  assert.equal(replaySign.kind, 'ok');
  assert.equal(replaySign.kind === 'ok' && replaySign.affected[0].status, 'done', '返回的是历史成功结果');
  assert.deepEqual(m2.getSnapshot('p'), before, '历史签核不会把已返工的步骤改回已完成');
  m2.close();
});

test('相同键不同内容：拒绝执行且不改变状态', () => {
  const db = freshDb();
  const m = new AuditModule(db);
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);

  const ok = m.submitReview('p', { requestKey: 'dup', stepId: 'A', expectedVersion: 0, text: '原文' });
  assert.equal(ok.kind, 'ok');
  ref.submit('dup', 'A', 0, '原文');

  const conflict1 = m.submitReview('p', { requestKey: 'dup', stepId: 'A', expectedVersion: 0, text: '篡改' });
  assert.equal(conflict1.kind, 'request_key_conflict');
  const conflict2 = m.signOff('p', { requestKey: 'dup', stepId: 'A', expectedVersion: 0 });
  assert.equal(conflict2.kind, 'request_key_conflict', '同键不同操作类型也冲突');
  const conflict3 = m.submitReview('p', { requestKey: 'dup', stepId: 'B', expectedVersion: 0, text: '原文' });
  assert.equal(conflict3.kind, 'request_key_conflict');

  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());
  m.close();
});

test('失败请求不占用键：版本冲突与前提不满足后可同键重试', () => {
  const db = freshDb();
  const m = new AuditModule(db);
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);

  const vc = m.submitReview('p', { requestKey: 'retry', stepId: 'A', expectedVersion: 5 });
  assert.equal(vc.kind, 'version_conflict');
  const pf = m.signOff('p', { requestKey: 'retry2', stepId: 'A', expectedVersion: 0 });
  assert.equal(pf.kind, 'precondition_failed');

  const ok1 = m.submitReview('p', { requestKey: 'retry', stepId: 'A', expectedVersion: 0 });
  assert.equal(ok1.kind, 'ok');
  ref.submit('retry', 'A', 0);
  const ok2 = m.submitReview('p', { requestKey: 'retry2', stepId: 'X', expectedVersion: 0 });
  assert.equal(ok2.kind, 'ok');
  ref.submit('retry2', 'X', 0);

  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());
  m.close();
});

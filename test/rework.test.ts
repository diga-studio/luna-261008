import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditModule } from '../src/index.js';
import { RefProject, assertSnapshotEquals, assertDonePredecessorsDone, diamondSpec } from './helpers.js';

function freshModule(): { m: AuditModule; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  return { m: new AuditModule(join(dir, 'test.db')), dir };
}

function completeAll(m: AuditModule, ref: RefProject, ids: string[], keyPrefix: string): void {
  for (const id of ids) {
    const v1 = ref.snapshot().find((s) => s.id === id)!.version;
    const r1 = m.submitReview('p', { requestKey: `${keyPrefix}-sub-${id}`, stepId: id, expectedVersion: v1 });
    assert.equal(r1.kind, 'ok');
    ref.submit(`${keyPrefix}-sub-${id}`, id, v1);
    const v2 = v1 + 1;
    const r2 = m.signOff('p', { requestKey: `${keyPrefix}-sign-${id}`, stepId: id, expectedVersion: v2 });
    assert.equal(r2.kind, 'ok');
    ref.signoff(`${keyPrefix}-sign-${id}`, id, v2);
  }
}

test('多层菱形依赖：返工根步骤，共享后继只加一次版本，不相干支线不变', () => {
  const { m } = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);

  completeAll(m, ref, ['A', 'X', 'B', 'C', 'D', 'E', 'Y'], 't1');
  const before = m.getSnapshot('p');
  assertDonePredecessorsDone(spec, before);
  assertSnapshotEquals(before, ref.snapshot());

  const beforeE = before.steps.find((s) => s.id === 'E')!;
  const beforeX = before.steps.find((s) => s.id === 'X')!;
  const beforeY = before.steps.find((s) => s.id === 'Y')!;

  const result = m.rework('p', { requestKey: 'rw-A', stepId: 'A', expectedVersion: 2 });
  assert.equal(result.kind, 'ok');
  ref.rework('rw-A', 'A', 2);

  if (result.kind === 'ok') {
    const ids = result.affected.map((s) => s.id).sort();
    assert.deepEqual(ids, ['A', 'B', 'C', 'D', 'E']);
    const e = result.affected.find((s) => s.id === 'E')!;
    assert.equal(e.version, beforeE.version + 1, '共享后继 E 只增加一次版本');
    assert.equal(e.status, 'todo');
    assert.equal(e.text, 'doc-E', '底稿文本保留');
  }

  const after = m.getSnapshot('p');
  assertSnapshotEquals(after, ref.snapshot());
  assertDonePredecessorsDone(spec, after);

  const afterX = after.steps.find((s) => s.id === 'X')!;
  const afterY = after.steps.find((s) => s.id === 'Y')!;
  assert.deepEqual(afterX, beforeX, '支线 X 完全不变');
  assert.deepEqual(afterY, beforeY, '支线 Y 完全不变');
  m.close();
});

test('返工中间步骤：仅它与后继回到待办，前驱保持已完成', () => {
  const { m } = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);
  completeAll(m, ref, ['A', 'X', 'B', 'C', 'D', 'E', 'Y'], 't2');

  const result = m.rework('p', { requestKey: 'rw-B', stepId: 'B', expectedVersion: 2 });
  assert.equal(result.kind, 'ok');
  ref.rework('rw-B', 'B', 2);
  if (result.kind === 'ok') {
    assert.deepEqual(result.affected.map((s) => s.id).sort(), ['B', 'D', 'E']);
  }
  const after = m.getSnapshot('p');
  assertSnapshotEquals(after, ref.snapshot());
  assertDonePredecessorsDone(spec, after);
  assert.equal(after.steps.find((s) => s.id === 'A')!.status, 'done');
  assert.equal(after.steps.find((s) => s.id === 'C')!.status, 'done');
  m.close();
});

test('返工已在待办的步骤：版本仍只加 1', () => {
  const { m } = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);

  const result = m.rework('p', { requestKey: 'rw-todo', stepId: 'A', expectedVersion: 0 });
  assert.equal(result.kind, 'ok');
  ref.rework('rw-todo', 'A', 0);
  if (result.kind === 'ok') {
    for (const s of result.affected) {
      assert.equal(s.version, 1);
      assert.equal(s.status, 'todo');
    }
  }
  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());
  m.close();
});

test('返工版本不符：不产生任何变化', () => {
  const { m } = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);
  const ref = new RefProject(spec);
  completeAll(m, ref, ['A', 'X', 'B', 'C', 'D', 'E', 'Y'], 't4');
  const before = m.getSnapshot('p');

  const result = m.rework('p', { requestKey: 'rw-bad', stepId: 'A', expectedVersion: 99 });
  assert.equal(result.kind, 'version_conflict');
  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());
  assert.deepEqual(m.getSnapshot('p'), before);

  const retry = m.rework('p', { requestKey: 'rw-bad', stepId: 'A', expectedVersion: 2 });
  assert.equal(retry.kind, 'ok', '失败请求不占用键，同键可携带正确内容重试');
  ref.rework('rw-bad', 'A', 2);
  assertSnapshotEquals(m.getSnapshot('p'), ref.snapshot());
  m.close();
});

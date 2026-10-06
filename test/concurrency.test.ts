import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditModule, MutationResult } from '../src/index.js';
import { assertDonePredecessorsDone, diamondSpec } from './helpers.js';

function freshModule(): AuditModule {
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  return new AuditModule(join(dir, 'test.db'));
}

test('上游返工与下游签核并发：结果对应某个合法串行顺序', async () => {
  const m = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);

  m.submitReview('p', { requestKey: 's1', stepId: 'A', expectedVersion: 0 });
  m.signOff('p', { requestKey: 's2', stepId: 'A', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 's3', stepId: 'B', expectedVersion: 0 });
  m.signOff('p', { requestKey: 's4', stepId: 'B', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 's5', stepId: 'C', expectedVersion: 0 });
  m.signOff('p', { requestKey: 's6', stepId: 'C', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 's7', stepId: 'D', expectedVersion: 0 });
  m.signOff('p', { requestKey: 's8', stepId: 'D', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 's9', stepId: 'E', expectedVersion: 0 });

  const outcomes: MutationResult[] = await Promise.all([
    (async () => m.rework('p', { requestKey: 'c-rw', stepId: 'A', expectedVersion: 2 }))(),
    (async () => m.signOff('p', { requestKey: 'c-sign', stepId: 'E', expectedVersion: 1 }))(),
  ]);

  const snap = m.getSnapshot('p');
  assertDonePredecessorsDone(spec, snap);
  const e = snap.steps.find((s) => s.id === 'E')!;

  const reworkFirst = outcomes[0].kind === 'ok' && outcomes[1].kind === 'version_conflict';
  const signoffFirst = outcomes[0].kind === 'version_conflict' && outcomes[1].kind === 'ok';
  assert.ok(reworkFirst || signoffFirst, '必须等价于某个串行顺序');

  if (reworkFirst) {
    assert.equal(e.status, 'todo', '返工先生效：E 被撤销回待办');
    assert.equal(e.version, 2);
  } else {
    assert.equal(e.status, 'done', '签核先生效：E 保持已完成');
    assert.equal(e.version, 2);
  }
  m.close();
});

test('32 个并发变更调用：等价于串行执行，快照不变量保持', async () => {
  const m = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);
  m.submitReview('p', { requestKey: 'i1', stepId: 'A', expectedVersion: 0 });
  m.signOff('p', { requestKey: 'i2', stepId: 'A', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 'i3', stepId: 'B', expectedVersion: 0 });
  m.signOff('p', { requestKey: 'i4', stepId: 'B', expectedVersion: 1 });

  const calls: Array<() => MutationResult> = [];
  for (let i = 0; i < 32; i += 1) {
    if (i % 2 === 0) {
      calls.push(() => m.rework('p', { requestKey: `p-rw-${i}`, stepId: 'A', expectedVersion: 2 }));
    } else {
      calls.push(() => m.signOff('p', { requestKey: `p-sign-${i}`, stepId: 'C', expectedVersion: 0 }));
    }
  }
  const results = await Promise.all(calls.map(async (fn) => fn()));

  const okReworks = results.filter((r, i) => i % 2 === 0 && r.kind === 'ok');
  assert.equal(okReworks.length, 1, '相同预期版本的返工只有一个能成功');
  const snap = m.getSnapshot('p');
  assertDonePredecessorsDone(spec, snap);
  const a = snap.steps.find((s) => s.id === 'A')!;
  assert.equal(a.version, 3, 'A 的版本只被成功返工推进一次');
  m.close();
});

test('返工后重新提交复核，旧版本的新签核请求必须拒绝', () => {
  const m = freshModule();
  const spec = diamondSpec('p');
  m.initProject(spec);

  m.submitReview('p', { requestKey: 'r1', stepId: 'A', expectedVersion: 0 });
  m.signOff('p', { requestKey: 'r2', stepId: 'A', expectedVersion: 1 });
  m.submitReview('p', { requestKey: 'r3', stepId: 'B', expectedVersion: 0 });
  const bVersionBeforeRework = 1;

  const rw = m.rework('p', { requestKey: 'r4', stepId: 'A', expectedVersion: 2 });
  assert.equal(rw.kind, 'ok');
  const bAfterRework = m.getSnapshot('p').steps.find((s) => s.id === 'B')!;
  assert.equal(bAfterRework.status, 'todo');
  assert.equal(bAfterRework.text, 'doc-B', '返工保留底稿文本');

  const aNow = m.getSnapshot('p').steps.find((s) => s.id === 'A')!;
  m.submitReview('p', { requestKey: 'r4b', stepId: 'A', expectedVersion: aNow.version });
  m.signOff('p', { requestKey: 'r4c', stepId: 'A', expectedVersion: aNow.version + 1 });
  const resubmit = m.submitReview('p', {
    requestKey: 'r5',
    stepId: 'B',
    expectedVersion: bAfterRework.version,
  });
  assert.equal(resubmit.kind, 'ok', '底稿文本不变也可重新提交复核');

  const staleSignoff = m.signOff('p', {
    requestKey: 'r6',
    stepId: 'B',
    expectedVersion: bVersionBeforeRework,
  });
  assert.equal(staleSignoff.kind, 'version_conflict', '旧版本的新签核请求必须冲突');

  const freshSignoff = m.signOff('p', {
    requestKey: 'r7',
    stepId: 'B',
    expectedVersion: bAfterRework.version + 1,
  });
  assert.equal(freshSignoff.kind, 'ok');
  m.close();
});

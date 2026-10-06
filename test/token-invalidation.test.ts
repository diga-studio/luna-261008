import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShipCycle } from '../src/index.js';
import type { ConfirmToken } from '../src/index.js';

async function newReleasableModule(): Promise<{ sc: ShipCycle; token: ConfirmToken }> {
  const sc = new ShipCycle({ path: ':memory:' });
  await sc.initRelease({ releaseId: 'R1', components: ['C1'], checklistItems: ['g1'] });
  await sc.initRelease({ releaseId: 'R2', components: ['C2'], checklistItems: ['g2'] });
  await sc.applyBatch('R1', {
    expectedStates: [{ componentId: 'C1', state: 'Ready' }],
    tests: [{ componentId: 'C1', testId: 'T1', completedAt: 100, passed: 96, total: 100, skipped: 0 }],
    checklist: [{ item: 'g1', done: true }],
  });
  const preview = await sc.previewGate('R1');
  assert.equal(preview.releasable, true);
  assert.ok(preview.token);
  return { sc, token: preview.token };
}

test('unrelated release updates do not invalidate token', async () => {
  const { sc, token } = await newReleasableModule();
  const versionBefore = (await sc.getRelease('R1')).gateVersion;

  await sc.applyBatch('R2', {
    expectedStates: [{ componentId: 'C2', state: 'Ready' }],
    tests: [{ componentId: 'C2', testId: 'X1', completedAt: 1, passed: 1, total: 1, skipped: 0 }],
    checklist: [{ item: 'g2', done: true }],
    bugs: [{ bugId: 'UB1', componentId: 'C2', severity: 'P0', status: 'Open' }],
  });

  assert.equal((await sc.getRelease('R1')).gateVersion, versionBefore);
  const result = await sc.confirmRelease('R1', token);
  assert.equal(result.ok, true);
  await sc.close();
});

test('late-arriving old test that never becomes latest does not invalidate token', async () => {
  const { sc, token } = await newReleasableModule();
  const versionBefore = (await sc.getRelease('R1')).gateVersion;

  // 迟到旧测试：完成时间早于最新测试
  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T0-late', completedAt: 50, passed: 0, total: 10, skipped: 0 }],
  });

  assert.equal((await sc.getRelease('R1')).gateVersion, versionBefore);
  const result = await sc.confirmRelease('R1', token);
  assert.equal(result.ok, true);
  await sc.close();
});

test('non-P0-set-changing bug updates do not invalidate token', async () => {
  const { sc, token } = await newReleasableModule();
  const versionBefore = (await sc.getRelease('R1')).gateVersion;

  // 普通 Bug（非 P0）更新不改变 P0 阻塞集合
  await sc.applyBatch('R1', {
    bugs: [{ bugId: 'NB1', componentId: 'C1', severity: 'P1', status: 'Open' }],
  });
  await sc.applyBatch('R1', {
    bugs: [{ bugId: 'NB1', componentId: 'C1', status: 'In Progress' }],
  });

  assert.equal((await sc.getRelease('R1')).gateVersion, versionBefore);
  const result = await sc.confirmRelease('R1', token);
  assert.equal(result.ok, true);
  await sc.close();
});

test('relevant facts changed then reverted across two batches still invalidates old token', async () => {
  const { sc, token } = await newReleasableModule();

  // 期望状态改走再改回
  await sc.applyBatch('R1', { expectedStates: [{ componentId: 'C1', state: 'Blocked' }] });
  await sc.applyBatch('R1', { expectedStates: [{ componentId: 'C1', state: 'Ready' }] });

  // 当前确实处于可发布状态
  const preview = await sc.previewGate('R1');
  assert.equal(preview.releasable, true);

  // 旧凭据必须被拒绝
  const stale = await sc.confirmRelease('R1', token);
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? '', /stale/);
  assert.equal((await sc.getRelease('R1')).status, 'Planning');

  // 新凭据可以确认
  const fresh = await sc.previewGate('R1');
  const confirmed = await sc.confirmRelease('R1', fresh.token!);
  assert.equal(confirmed.ok, true);
  await sc.close();
});

test('P0 set change and revert invalidates; checklist toggle and revert invalidates', async () => {
  const { sc, token } = await newReleasableModule();

  // P0 阻塞集合改变再改回
  await sc.applyBatch('R1', { bugs: [{ bugId: 'PB', componentId: 'C1', severity: 'P0', status: 'Open' }] });
  await sc.applyBatch('R1', { bugs: [{ bugId: 'PB', componentId: 'C1', status: 'Resolved' }] });
  let result = await sc.confirmRelease('R1', token);
  assert.equal(result.ok, false);

  // 清单完成标记改回再改回
  const token2 = (await sc.previewGate('R1')).token!;
  await sc.applyBatch('R1', { checklist: [{ item: 'g1', done: false }] });
  await sc.applyBatch('R1', { checklist: [{ item: 'g1', done: true }] });
  result = await sc.confirmRelease('R1', token2);
  assert.equal(result.ok, false);

  // 最新测试变化（新提交的测试成为最新）也使凭据失效
  const token3 = (await sc.previewGate('R1')).token!;
  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T2', completedAt: 200, passed: 100, total: 100, skipped: 0 }],
  });
  result = await sc.confirmRelease('R1', token3);
  assert.equal(result.ok, false);

  const fresh = await sc.previewGate('R1');
  assert.equal((await sc.confirmRelease('R1', fresh.token!)).ok, true);
  await sc.close();
});

test('bug update on shared component from another release invalidates token', async () => {
  const { sc, token } = await newReleasableModule();
  // R3 与 R1 共享组件 C1
  await sc.initRelease({ releaseId: 'R3', components: ['C1'], checklistItems: ['g3'] });
  await sc.applyBatch('R3', { bugs: [{ bugId: 'SH1', componentId: 'C1', severity: 'P0', status: 'Open' }] });

  const result = await sc.confirmRelease('R1', token);
  assert.equal(result.ok, false);
  const preview = await sc.previewGate('R1');
  assert.equal(preview.releasable, false);
  assert.deepEqual(preview.basis.components[0].p0BlockingBugs, ['SH1']);
  await sc.close();
});

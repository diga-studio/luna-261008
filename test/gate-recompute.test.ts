import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShipCycle } from '../src/index.js';

function newModule(): ShipCycle {
  return new ShipCycle({ path: ':memory:' });
}

test('shared component with two P0 blocks, staggered fixes, out-of-order and same-time tests', async () => {
  const sc = newModule();
  await sc.initRelease({ releaseId: 'R1', components: ['C1'], checklistItems: ['gtm-1'] });
  await sc.initRelease({ releaseId: 'R2', components: ['C1'], checklistItems: ['gtm-2'] });

  // 组件上同时存在两个 P0 阻塞
  await sc.applyBatch('R1', {
    bugs: [
      { bugId: 'B1', componentId: 'C1', severity: 'P0', status: 'Open' },
      { bugId: 'B2', componentId: 'C1', severity: 'P0', status: 'In Progress' },
    ],
  });

  // 期望设为 Ready，但 P0 阻塞使实际状态必须为 Blocked，且两个发布都受影响
  await sc.applyBatch('R1', { expectedStates: [{ componentId: 'C1', state: 'Ready' }] });
  let p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].expected, 'Ready');
  assert.equal(p1.basis.components[0].actual, 'Blocked');
  assert.deepEqual(p1.basis.components[0].p0BlockingBugs, ['B1', 'B2']);
  assert.equal(p1.releasable, false);
  const p2 = await sc.previewGate('R2');
  assert.equal(p2.basis.components[0].actual, 'Blocked');
  assert.deepEqual(p2.basis.components[0].p0BlockingBugs, ['B1', 'B2']);

  // 乱序测试：先提交完成时间晚的 T2（达标），再提交完成时间早的 T1（不达标）
  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T2', completedAt: 200, passed: 19, total: 20, skipped: 0 }],
  });
  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T1', completedAt: 100, passed: 0, total: 10, skipped: 0 }],
  });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].latestTest?.testId, 'T2');
  assert.equal(p1.basis.components[0].latestTest?.passing, true);

  // 同时间测试：completedAt 相同，取 testId 字典序最大者（T4 > T3）
  await sc.applyBatch('R1', {
    tests: [
      { componentId: 'C1', testId: 'T3', completedAt: 200, passed: 20, total: 20, skipped: 0 },
      { componentId: 'C1', testId: 'T4', completedAt: 200, passed: 9, total: 10, skipped: 1 },
    ],
  });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].latestTest?.testId, 'T4');
  // skipped 计入分母：9/10 = 90% < 95%，不达标
  assert.equal(p1.basis.components[0].latestTest?.passRate, 0.9);
  assert.equal(p1.basis.components[0].latestTest?.passing, false);

  // 解除第一个 P0：仍被 B2 阻塞
  await sc.applyBatch('R2', { bugs: [{ bugId: 'B1', componentId: 'C1', status: 'Resolved' }] });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].actual, 'Blocked');
  assert.deepEqual(p1.basis.components[0].p0BlockingBugs, ['B2']);

  // 解除第二个 P0：阻塞解除，无需再次手工设置期望，按当前事实重算
  // 期望 Ready 但最新测试 T4 不达标 → 实际 In Progress
  await sc.applyBatch('R2', { bugs: [{ bugId: 'B2', componentId: 'C1', status: 'Closed' }] });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].expected, 'Ready');
  assert.equal(p1.basis.components[0].actual, 'In Progress');
  assert.equal(p1.releasable, false);

  // 追加达标测试后实际 Ready；完成清单后可发布
  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T5', completedAt: 300, passed: 95, total: 100, skipped: 5 }],
  });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.basis.components[0].actual, 'Ready');
  assert.equal(p1.releasable, false); // 清单未完成
  await sc.applyBatch('R1', { checklist: [{ item: 'gtm-1', done: true }] });
  p1 = await sc.previewGate('R1');
  assert.equal(p1.releasable, true);
  assert.deepEqual(p1.blockingReasons, []);

  // R2 没有测试，期望未设 → 实际 Not Started，不可发布
  const p2b = await sc.previewGate('R2');
  assert.equal(p2b.basis.components[0].actual, 'Not Started');
  assert.equal(p2b.releasable, false);

  await sc.close();
});

test('total=0 or no tests never passes; P0 re-open blocks again without manual reset', async () => {
  const sc = newModule();
  await sc.initRelease({ releaseId: 'R1', components: ['C1'], checklistItems: ['g'] });
  await sc.applyBatch('R1', {
    expectedStates: [{ componentId: 'C1', state: 'Ready' }],
    tests: [{ componentId: 'C1', testId: 'T0', completedAt: 1, passed: 0, total: 0, skipped: 0 }],
  });
  let p = await sc.previewGate('R1');
  assert.equal(p.basis.components[0].latestTest?.passing, false);
  assert.equal(p.basis.components[0].actual, 'In Progress');

  await sc.applyBatch('R1', {
    tests: [{ componentId: 'C1', testId: 'T1', completedAt: 2, passed: 100, total: 100, skipped: 0 }],
    checklist: [{ item: 'g', done: true }],
  });
  p = await sc.previewGate('R1');
  assert.equal(p.releasable, true);

  // 重新打开 P0 → 自动 Blocked；解决后按事实恢复 Ready，无需手工重设期望
  await sc.applyBatch('R1', { bugs: [{ bugId: 'BX', componentId: 'C1', severity: 'P0', status: 'Open' }] });
  p = await sc.previewGate('R1');
  assert.equal(p.basis.components[0].actual, 'Blocked');
  assert.equal(p.basis.components[0].expected, 'Ready');
  await sc.applyBatch('R1', { bugs: [{ bugId: 'BX', componentId: 'C1', status: 'Resolved' }] });
  p = await sc.previewGate('R1');
  assert.equal(p.basis.components[0].actual, 'Ready');
  assert.equal(p.releasable, true);

  await sc.close();
});

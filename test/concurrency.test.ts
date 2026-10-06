import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShipCycle } from '../src/index.js';

async function makeReleasable(sc: ShipCycle, releaseId: string): Promise<void> {
  await sc.initRelease({ releaseId, components: ['C1'], checklistItems: ['g1'] });
  await sc.applyBatch(releaseId, {
    expectedStates: [{ componentId: 'C1', state: 'Ready' }],
    tests: [{ componentId: 'C1', testId: 'T1', completedAt: 1, passed: 100, total: 100, skipped: 0 }],
    checklist: [{ item: 'g1', done: true }],
  });
}

test('confirm racing new P0: exactly one consistent outcome, never confirmed-with-blocking-basis', async () => {
  for (let round = 0; round < 20; round++) {
    const sc = new ShipCycle({ path: ':memory:' });
    await makeReleasable(sc, 'R1');
    const token = (await sc.previewGate('R1')).token!;

    // 若确认先完成，发布已冻结，针对它的批次会被拒绝——这属于合法的串行结果之一
    const addP0 = () =>
      sc
        .applyBatch('R1', { bugs: [{ bugId: 'P0X', componentId: 'C1', severity: 'P0', status: 'Open' }] })
        .catch(() => {});
    const confirm = () => sc.confirmRelease('R1', token);

    // 交替两种调用顺序，模拟两种交错时序
    let confirmResult: Awaited<ReturnType<typeof confirm>>;
    if (round % 2 === 0) {
      [confirmResult] = await Promise.all([confirm(), addP0()]);
    } else {
      [, confirmResult] = await Promise.all([addP0(), confirm()]);
    }

    const release = await sc.getRelease('R1');
    if (confirmResult.ok) {
      // 确认先完成：依据中不含 P0，记录不可变，之后的 Bug 变化不回写
      assert.equal(release.status, 'Released');
      assert.ok(confirmResult.record);
      assert.deepEqual(confirmResult.record!.components[0].p0BlockingBugs, []);
      const after = await sc.previewGate('R1');
      assert.equal(after.status, 'Released');
      assert.deepEqual(after.basis.components[0].p0BlockingBugs, []);
    } else {
      // P0 先生效：确认失败，发布仍为 Planning，且不留成功记录
      assert.equal(release.status, 'Planning');
      assert.equal(confirmResult.record, null);
      const preview = await sc.previewGate('R1');
      assert.equal(preview.releasable, false);
      assert.deepEqual(preview.basis.components[0].p0BlockingBugs, ['P0X']);
    }
    await sc.close();
  }
});

test('32 concurrent mixed calls behave as some serial order', async () => {
  const sc = new ShipCycle({ path: ':memory:' });
  await sc.initRelease({ releaseId: 'R1', components: ['C1'], checklistItems: ['g1'] });

  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 32; i++) {
    if (i % 4 === 0) {
      ops.push(sc.applyBatch('R1', { expectedStates: [{ componentId: 'C1', state: 'Ready' }] }));
    } else if (i % 4 === 1) {
      ops.push(
        sc.applyBatch('R1', {
          tests: [{ componentId: 'C1', testId: `T${i}`, completedAt: i, passed: 100, total: 100, skipped: 0 }],
        }),
      );
    } else if (i % 4 === 2) {
      ops.push(sc.previewGate('R1'));
    } else {
      ops.push(sc.applyBatch('R1', { checklist: [{ item: 'g1', done: true }] }));
    }
  }
  const results = await Promise.all(ops);

  // 所有预览结果内部自洽：依据与实际状态一致（不混合不同状态）
  for (const r of results) {
    if (r && typeof r === 'object' && 'basis' in r) {
      const preview = r as Awaited<ReturnType<ShipCycle['previewGate']>>;
      for (const c of preview.basis.components) {
        if (c.p0BlockingBugs.length > 0) assert.equal(c.actual, 'Blocked');
      }
    }
  }
  // 最终状态等价于按某顺序全部执行完：期望 Ready、清单完成、最新测试为 completedAt 最大者
  const final = await sc.previewGate('R1');
  assert.equal(final.basis.components[0].expected, 'Ready');
  assert.equal(final.basis.checklist[0].done, true);
  assert.equal(final.basis.components[0].latestTest?.testId, 'T29');
  assert.equal(final.releasable, true);
  await sc.close();
});

test('release records survive close and reopen; failed confirm leaves no trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcycle-'));
  const path = join(dir, 'gate.db');
  try {
    let sc = new ShipCycle({ path });
    await makeReleasable(sc, 'R1');
    await sc.initRelease({ releaseId: 'R2', components: ['C2'], checklistItems: ['g2'] });

    // R2 不可发布时确认失败：不得留下 Released 状态或成功记录
    const badToken = (await sc.previewGate('R2')).token!;
    const failed = await sc.confirmRelease('R2', badToken);
    assert.equal(failed.ok, false);

    const token = (await sc.previewGate('R1')).token!;
    const confirmed = await sc.confirmRelease('R1', token);
    assert.equal(confirmed.ok, true);
    await sc.close();

    // 重新打开模块：发布记录仍可读取
    sc = new ShipCycle({ path });
    const r1 = await sc.getRelease('R1');
    assert.equal(r1.status, 'Released');
    const r2 = await sc.getRelease('R2');
    assert.equal(r2.status, 'Planning');

    const preview = await sc.previewGate('R1');
    assert.equal(preview.status, 'Released');
    assert.equal(preview.token, null);
    assert.deepEqual(preview.basis, confirmed.record && {
      releaseId: confirmed.record.releaseId,
      components: confirmed.record.components,
      checklist: confirmed.record.checklist,
    });

    // 同一发布只能成功确认一次
    const again = await sc.confirmRelease('R1', token);
    assert.equal(again.ok, false);

    // 共享组件的后续 Bug 变化不回写已发布记录
    await sc.initRelease({ releaseId: 'R3', components: ['C1'], checklistItems: ['g3'] });
    await sc.applyBatch('R3', { bugs: [{ bugId: 'LATE', componentId: 'C1', severity: 'P0', status: 'Open' }] });
    const previewAfter = await sc.previewGate('R1');
    assert.deepEqual(previewAfter.basis.components[0].p0BlockingBugs, []);
    await sc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

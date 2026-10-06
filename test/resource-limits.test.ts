import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openService, assertConsistent } from './helpers';
import { SkuQuantities } from '../src/types';

test('库存用满但容量足够时原地拆分成功', () => {
  const LOCS = [
    { locationId: 'L1', capacity: 5, inventory: { A: { total: 100, safetyStock: 10 } } },
  ];
  const { service, cleanup } = openService();
  try {
    assert.ok(service.configureLocation('L1', 5, { A: { total: 100, safetyStock: 10 } }).ok);
    const submitted = new Map<string, SkuQuantities>([['O1', { A: 90 }]]);
    const canceled = new Set<string>();

    // 用满可用库存（100 - 10 = 90）
    const fo = service.submitOrder('O1', 'L1', { A: 90 });
    assert.ok(fo.ok);
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, { A: 90 });

    // 再提交任何正数量都会超库存
    const overflow = service.submitOrder('O2', 'L1', { A: 1 });
    assert.ok(!overflow.ok);

    // 原地拆分：库存已被输入单占满，但原预留参与重新核算，且容量足够
    const split = service.split(fo.value, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 50 } }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 40 } }] },
    ]);
    assert.ok(split.ok, split.ok ? '' : split.error);
    assert.equal(service.getFulfillment(fo.value)!.status, 'inactive');
    const usage = service.getLocationUsage('L1')!;
    assert.deepEqual(usage.reserved, { A: 90 });
    assert.equal(usage.activeFulfillments, 2);
    assertConsistent(service, submitted, canceled, LOCS);
  } finally {
    cleanup();
  }
});

test('目标资源不足时整个操作不生效，输入单及原预留保持不变', () => {
  const LOCS = [
    { locationId: 'L1', capacity: 3, inventory: { A: { total: 100, safetyStock: 0 } } },
    { locationId: 'L2', capacity: 1, inventory: { A: { total: 10, safetyStock: 0 } } },
  ];
  const { service, cleanup } = openService();
  try {
    assert.ok(service.configureLocation('L1', 3, { A: { total: 100, safetyStock: 0 } }).ok);
    assert.ok(service.configureLocation('L2', 1, { A: { total: 10, safetyStock: 0 } }).ok);
    const submitted = new Map<string, SkuQuantities>([
      ['O1', { A: 30 }],
      ['O2', { A: 20 }],
    ]);
    const canceled = new Set<string>();
    const fo1 = service.submitOrder('O1', 'L1', { A: 30 });
    const fo2 = service.submitOrder('O2', 'L1', { A: 20 });
    assert.ok(fo1.ok && fo2.ok);
    const before = service.listActiveFulfillments();

    // 合并到 L2：库存（10）不足，整体失败
    const mergeFail = service.merge([fo1.value, fo2.value], 'L2');
    assert.ok(!mergeFail.ok);
    assert.equal(service.getFulfillment(fo1.value)!.status, 'active');
    assert.equal(service.getFulfillment(fo2.value)!.status, 'active');
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, { A: 50 });
    assert.deepEqual(service.getLocationUsage('L2')!.reserved, {});
    assert.equal(service.getLocationUsage('L2')!.activeFulfillments, 0);
    assert.deepEqual(service.listActiveFulfillments(), before);
    assertConsistent(service, submitted, canceled, LOCS);

    // 拆分到 L2：容量（1张）不足，整体失败
    const splitFail = service.split(fo1.value, [
      { locationId: 'L2', lines: [{ orderId: 'O1', quantities: { A: 5 } }] },
      { locationId: 'L2', lines: [{ orderId: 'O1', quantities: { A: 25 } }] },
    ]);
    assert.ok(!splitFail.ok);
    assert.equal(service.getFulfillment(fo1.value)!.status, 'active');
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, { A: 50 });
    assert.deepEqual(service.listActiveFulfillments(), before);
    assertConsistent(service, submitted, canceled, LOCS);

    // 拆分数量与被拆单不完全相等：失败且不变
    const mismatch = service.split(fo1.value, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 10 } }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 10 } }] },
    ]);
    assert.ok(!mismatch.ok);
    assert.deepEqual(service.listActiveFulfillments(), before);
    assertConsistent(service, submitted, canceled, LOCS);

    // 已失效单不能再次参与拆并
    const okSplit = service.split(fo1.value, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 15 } }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 15 } }] },
    ]);
    assert.ok(okSplit.ok, okSplit.ok ? '' : okSplit.error);
    const reuse = service.merge([fo1.value, fo2.value], 'L1');
    assert.ok(!reuse.ok);
    const reuseSplit = service.split(fo1.value, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 15 } }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 15 } }] },
    ]);
    assert.ok(!reuseSplit.ok);
    assertConsistent(service, submitted, canceled, LOCS);
  } finally {
    cleanup();
  }
});

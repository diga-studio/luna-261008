import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openService, assertConsistent } from './helpers';
import { SkuQuantities } from '../src/types';

const LOCS = [
  { locationId: 'L1', capacity: 10, inventory: { A: { total: 100, safetyStock: 5 } } },
  { locationId: 'L2', capacity: 10, inventory: { A: { total: 100, safetyStock: 5 } } },
  { locationId: 'L3', capacity: 10, inventory: { A: { total: 100, safetyStock: 5 } } },
];

test('不同原始订单的相同SKU先合并再跨地点拆分，取消其一后另一订单完全保留', () => {
  const { service, cleanup } = openService();
  try {
    for (const loc of LOCS) {
      assert.ok(service.configureLocation(loc.locationId, loc.capacity, loc.inventory).ok);
    }
    const submitted = new Map<string, SkuQuantities>([
      ['O1', { A: 30 }],
      ['O2', { A: 40 }],
    ]);
    const canceled = new Set<string>();

    const fo1 = service.submitOrder('O1', 'L1', { A: 30 });
    const fo2 = service.submitOrder('O2', 'L1', { A: 40 });
    assert.ok(fo1.ok && fo2.ok);

    // 合并到 L2：相同 SKU 累加，但订单归属保留
    const merged = service.merge([fo1.value, fo2.value], 'L2');
    assert.ok(merged.ok, merged.ok ? '' : merged.error);
    const mergedFo = service.getFulfillment(merged.value)!;
    assert.equal(mergedFo.locationId, 'L2');
    assert.deepEqual(mergedFo.lines, { O1: { A: 30 }, O2: { A: 40 } });
    assert.equal(service.getFulfillment(fo1.value)!.status, 'inactive');
    assert.equal(service.getFulfillment(fo2.value)!.status, 'inactive');
    assertConsistent(service, submitted, canceled, LOCS);

    // 跨地点拆分到 L1 和 L3
    const split = service.split(merged.value, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 10 } }, { orderId: 'O2', quantities: { A: 25 } }] },
      { locationId: 'L3', lines: [{ orderId: 'O1', quantities: { A: 20 } }, { orderId: 'O2', quantities: { A: 15 } }] },
    ]);
    assert.ok(split.ok, split.ok ? '' : split.error);
    assert.equal(split.value.length, 2);
    assert.equal(service.getFulfillment(merged.value)!.status, 'inactive');
    assertConsistent(service, submitted, canceled, LOCS);

    // 取消 O1：O2 的数量和预留完全保留
    assert.ok(service.cancelOrder('O1').ok);
    canceled.add('O1');
    assert.deepEqual(service.getOrderQuantities('O1'), {});
    assert.deepEqual(service.getOrderQuantities('O2'), { A: 40 });
    const l1 = service.getLocationUsage('L1')!;
    const l3 = service.getLocationUsage('L3')!;
    assert.deepEqual(l1.reserved, { A: 25 });
    assert.deepEqual(l3.reserved, { A: 15 });
    // 两张拆分单都仍有 O2 的数量，继续生效、各占一个名额
    assert.equal(l1.activeFulfillments, 1);
    assert.equal(l3.activeFulfillments, 1);
    assertConsistent(service, submitted, canceled, LOCS);

    // 重复取消不再次释放
    assert.ok(service.cancelOrder('O1').ok);
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, { A: 25 });
    assertConsistent(service, submitted, canceled, LOCS);

    // 已取消订单不能被拆并操作重新带回
    const l1Fo = service.listActiveFulfillments().find((f) => f.locationId === 'L1')!;
    const badSplit = service.split(l1Fo.id, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 5 } }, { orderId: 'O2', quantities: { A: 25 } }] },
      { locationId: 'L3', lines: [{ orderId: 'O2', quantities: { A: 0 } as SkuQuantities }] },
    ]);
    assert.ok(!badSplit.ok);
    assertConsistent(service, submitted, canceled, LOCS);
  } finally {
    cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, checkInvariants } from './helpers.js';

test('不同订单相同 SKU 合并后跨地点拆分，取消一单后另一单完整保留', async () => {
  const store = openStore();
  const orders = ['O1', 'O2'];
  const locations = ['L1', 'L2'];
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 }, B: { total: 50, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 }, B: { total: 50, safetyStock: 0 } } });

  const f1 = await store.submitOrder('O1', 'L1', [
    { sku: 'A', quantity: 5 },
    { sku: 'B', quantity: 3 },
  ]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 7 }]);
  checkInvariants(store, orders, locations);

  // 合并到 L2：相同 SKU 累加，原始订单归属保留
  const merged = await store.merge([f1, f2], 'L2');
  const mergedView = store.getFulfillment(merged);
  assert.ok(mergedView);
  assert.deepEqual(mergedView.lines.get('A'), new Map([['O1', 5], ['O2', 7]]));
  assert.deepEqual(mergedView.lines.get('B'), new Map([['O1', 3]]));
  assert.equal(store.getFulfillment(f1)?.status, 'inactive');
  assert.equal(store.getFulfillment(f2)?.status, 'inactive');
  assert.equal(store.getLocationCapacity('L1').used, 0);
  assert.equal(store.getLocationCapacity('L2').used, 1);
  assert.equal(store.getLocationSku('L2', 'A').reserved, 12);
  checkInvariants(store, orders, locations);

  // 跨地点拆分：O1 的数量去 L1，O2 的数量留在 L2
  const [t1, t2] = (await store.split(merged, [
    {
      locationId: 'L1',
      lines: [
        { orderId: 'O1', sku: 'A', quantity: 5 },
        { orderId: 'O1', sku: 'B', quantity: 3 },
      ],
    },
    { locationId: 'L2', lines: [{ orderId: 'O2', sku: 'A', quantity: 7 }] },
  ])) as [string, string];
  assert.equal(store.getFulfillment(merged)?.status, 'inactive');
  checkInvariants(store, orders, locations);

  // 取消 O1：其履约单变空失效并释放名额与库存；O2 完全保留
  await store.cancelOrder('O1');
  assert.equal(store.getFulfillment(t1)?.status, 'inactive');
  assert.equal(store.getFulfillment(t2)?.status, 'active');
  assert.deepEqual(store.getFulfillment(t2)?.lines.get('A'), new Map([['O2', 7]]));
  assert.equal(store.getLocationSku('L1', 'A').reserved, 0);
  assert.equal(store.getLocationSku('L1', 'B').reserved, 0);
  assert.equal(store.getLocationSku('L2', 'A').reserved, 7);
  assert.equal(store.getLocationCapacity('L1').used, 0);
  assert.equal(store.getLocationCapacity('L2').used, 1);
  assert.equal(store.getOrder('O1')?.status, 'cancelled');
  checkInvariants(store, orders, locations);

  // 重复取消：不再次释放
  await store.cancelOrder('O1');
  checkInvariants(store, orders, locations);

  await store.close();
});

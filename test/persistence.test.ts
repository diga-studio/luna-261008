import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderInventoryStore } from '../src/index.js';
import { makeStorePath, checkInvariants } from './helpers.js';

test('正常关闭后重新打开，订单归属与资源占用不变', async () => {
  const path = makeStorePath();
  const orders = ['O1', 'O2', 'O3'];
  const locations = ['L1', 'L2'];

  const store = OrderInventoryStore.open({ filePath: path });
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 }, B: { total: 50, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 }, B: { total: 50, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [
    { sku: 'A', quantity: 5 },
    { sku: 'B', quantity: 3 },
  ]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 7 }]);
  const f3 = await store.submitOrder('O3', 'L2', [{ sku: 'B', quantity: 2 }]);
  const merged = await store.merge([f1, f2], 'L2');
  await store.cancelOrder('O3');
  checkInvariants(store, orders, locations);
  await store.close();

  // 重新打开：归属、失效状态、预留与容量完全一致
  const reopened = OrderInventoryStore.open({ filePath: path });
  assert.equal(reopened.getFulfillment(f1)?.status, 'inactive');
  assert.equal(reopened.getFulfillment(f2)?.status, 'inactive');
  assert.equal(reopened.getFulfillment(f3)?.status, 'inactive');
  const mergedView = reopened.getFulfillment(merged);
  assert.ok(mergedView);
  assert.equal(mergedView.status, 'active');
  assert.deepEqual(mergedView.lines.get('A'), new Map([['O1', 5], ['O2', 7]]));
  assert.deepEqual(mergedView.lines.get('B'), new Map([['O1', 3]]));
  assert.equal(reopened.getOrder('O3')?.status, 'cancelled');
  assert.equal(reopened.getLocationSku('L2', 'A').reserved, 12);
  assert.equal(reopened.getLocationSku('L2', 'B').reserved, 3);
  assert.equal(reopened.getLocationCapacity('L2').used, 1);
  checkInvariants(reopened, orders, locations);

  // 重开后继续操作：新履约单 ID 不与旧单冲突
  const f4 = await reopened.submitOrder('O4', 'L1', [{ sku: 'A', quantity: 1 }]);
  assert.ok(!reopened.getFulfillment(merged) || f4 !== merged);
  assert.equal(reopened.getFulfillment(f4)?.status, 'active');
  const [t1, t2] = (await reopened.split(merged, [
    { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }, { orderId: 'O1', sku: 'B', quantity: 3 }] },
    { locationId: 'L2', lines: [{ orderId: 'O2', sku: 'A', quantity: 7 }] },
  ])) as [string, string];
  assert.equal(reopened.getFulfillment(t1)?.status, 'active');
  assert.equal(reopened.getFulfillment(t2)?.status, 'active');
  checkInvariants(reopened, [...orders, 'O4'], locations);
  await reopened.close();

  // 再次重开，状态依然完整
  const again = OrderInventoryStore.open({ filePath: path });
  checkInvariants(again, [...orders, 'O4'], locations);
  assert.equal(again.getFulfillment(merged)?.status, 'inactive');
  await again.close();
});

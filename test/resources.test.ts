import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreError } from '../src/index.js';
import { openStore, checkInvariants } from './helpers.js';

test('库存用满但容量足够时，同地点原地拆分成功', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 10, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  assert.equal(store.getLocationSku('L1', 'A').available, 0);

  // 库存已被输入单自己占满，但原地拆分先释放原预留再核算，必须成功
  const [t1, t2] = (await store.split(f1, [
    { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 6 }] },
    { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 4 }] },
  ])) as [string, string];
  assert.equal(store.getFulfillment(f1)?.status, 'inactive');
  assert.equal(store.getFulfillment(t1)?.status, 'active');
  assert.equal(store.getFulfillment(t2)?.status, 'active');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  assert.equal(store.getLocationCapacity('L1').used, 2);
  checkInvariants(store, ['O1'], ['L1']);
  await store.close();
});

test('目标地点库存不足时拆分整体失败，输入单及原预留不变', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 10, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 10, skus: { A: { total: 6, safetyStock: 2 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);

  // L2 可用量 = 6 - 2 = 4，拆入 5 超出
  await assert.rejects(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }] },
      { locationId: 'L2', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }] },
    ]),
    (err: unknown) => err instanceof StoreError && err.code === 'INSUFFICIENT_STOCK',
  );
  assert.equal(store.getFulfillment(f1)?.status, 'active');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  assert.equal(store.getLocationSku('L2', 'A').reserved, 0);
  assert.equal(store.getLocationCapacity('L1').used, 1);
  assert.equal(store.getLocationCapacity('L2').used, 0);
  assert.equal(store.listActiveFulfillments().length, 1);
  checkInvariants(store, ['O1'], ['L1', 'L2']);
  await store.close();
});

test('目标地点容量不足时拆分整体失败，输入单及原预留不变', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 10, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 1, skus: { A: { total: 10, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);
  await store.submitOrder('O2', 'L2', [{ sku: 'A', quantity: 1 }]);

  // L2 容量 1 已被 O2 的履约单占用
  await assert.rejects(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }] },
      { locationId: 'L2', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }] },
    ]),
    (err: unknown) => err instanceof StoreError && err.code === 'INSUFFICIENT_CAPACITY',
  );
  assert.equal(store.getFulfillment(f1)?.status, 'active');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  assert.equal(store.getLocationSku('L2', 'A').reserved, 1);
  assert.equal(store.getLocationCapacity('L2').used, 1);
  checkInvariants(store, ['O1', 'O2'], ['L1', 'L2']);
  await store.close();
});

test('目标地点资源不足时合并整体失败，输入单保持生效', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 20, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 10, skus: { A: { total: 8, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 5 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 5 }]);

  // 合并后需要 10，L2 只有 8
  await assert.rejects(
    store.merge([f1, f2], 'L2'),
    (err: unknown) => err instanceof StoreError && err.code === 'INSUFFICIENT_STOCK',
  );
  assert.equal(store.getFulfillment(f1)?.status, 'active');
  assert.equal(store.getFulfillment(f2)?.status, 'active');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  assert.equal(store.getLocationSku('L2', 'A').reserved, 0);
  assert.equal(store.listActiveFulfillments().length, 2);
  checkInvariants(store, ['O1', 'O2'], ['L1', 'L2']);
  await store.close();
});

test('提交订单超出可用库存或容量时失败', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 1, skus: { A: { total: 5, safetyStock: 1 } } });
  await assert.rejects(
    store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 5 }]),
    (err: unknown) => err instanceof StoreError && err.code === 'INSUFFICIENT_STOCK',
  );
  await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 4 }]);
  await assert.rejects(
    store.submitOrder('O3', 'L1', [{ sku: 'A', quantity: 1 }]),
    (err: unknown) => err instanceof StoreError && err.code === 'INSUFFICIENT_CAPACITY',
  );
  checkInvariants(store, ['O2'], ['L1']);
  await store.close();
});

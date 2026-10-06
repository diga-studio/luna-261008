import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreError } from '../src/index.js';
import { openStore, checkInvariants } from './helpers.js';

test('同一履约单的拆分与其原始订单取消并发：最终状态对应某种串行顺序', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);
  await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 2 }]);

  const splitResult = await Promise.allSettled([
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 6 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 4 }] },
    ]),
    store.cancelOrder('O1'),
  ]);
  const [splitOutcome, cancelOutcome] = splitResult as [PromiseSettledResult<string[]>, PromiseSettledResult<void>];
  assert.equal(cancelOutcome.status, 'fulfilled');

  if (splitOutcome.status === 'fulfilled') {
    // 串行顺序为“先拆后取消”：拆出的两张单随后被取消清空而失效
    const [t1, t2] = splitOutcome.value as [string, string];
    assert.equal(store.getFulfillment(f1)?.status, 'inactive');
    assert.equal(store.getFulfillment(t1)?.status, 'inactive');
    assert.equal(store.getFulfillment(t2)?.status, 'inactive');
  } else {
    // 串行顺序为“先取消后拆”：原单已失效，拆分被拒绝
    assert.ok(splitOutcome.reason instanceof StoreError);
    assert.equal((splitOutcome.reason as StoreError).code, 'FULFILLMENT_NOT_ACTIVE');
    assert.equal(store.getFulfillment(f1)?.status, 'inactive');
  }
  // 两种顺序下：O1 数量为零，O2 的 2 件完好
  assert.equal(store.getOrder('O1')?.status, 'cancelled');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 2);
  checkInvariants(store, ['O1', 'O2'], ['L1']);
  await store.close();
});

test('合并与其中一个原始订单的取消并发：另一订单数量与预留完全保留', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  await store.configureLocation('L2', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 5 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 7 }]);

  const [mergeOutcome, cancelOutcome] = (await Promise.allSettled([
    store.merge([f1, f2], 'L2'),
    store.cancelOrder('O1'),
  ])) as [PromiseSettledResult<string>, PromiseSettledResult<void>];
  assert.equal(cancelOutcome.status, 'fulfilled');

  if (mergeOutcome.status === 'fulfilled') {
    // 先合并后取消：合并单仍生效，只剩 O2 的 7 件，继续占一个名额
    const merged = store.getFulfillment(mergeOutcome.value);
    assert.ok(merged);
    assert.equal(merged.status, 'active');
    assert.deepEqual(merged.lines.get('A'), new Map([['O2', 7]]));
    assert.equal(store.getLocationSku('L2', 'A').reserved, 7);
    assert.equal(store.getLocationCapacity('L2').used, 1);
    assert.equal(store.getLocationSku('L1', 'A').reserved, 0);
  } else {
    // 先取消后合并：f1 已失效，合并被拒绝；f2 仍在 L1 保留 O2 的 7 件
    assert.ok(mergeOutcome.reason instanceof StoreError);
    assert.equal((mergeOutcome.reason as StoreError).code, 'FULFILLMENT_NOT_ACTIVE');
    assert.equal(store.getFulfillment(f2)?.status, 'active');
    assert.equal(store.getLocationSku('L1', 'A').reserved, 7);
    assert.equal(store.getLocationSku('L2', 'A').reserved, 0);
  }
  checkInvariants(store, ['O1', 'O2'], ['L1', 'L2']);
  await store.close();
});

test('64 个并发调用交错执行，期间任意读取均满足不变量', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 64, skus: { A: { total: 640, safetyStock: 0 } } });
  const orderIds: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    orderIds.push(`O${i}`);
  }
  // 64 个并发提交
  await Promise.all(orderIds.map((id) => store.submitOrder(id, 'L1', [{ sku: 'A', quantity: 10 }])));
  checkInvariants(store, orderIds, ['L1']);
  assert.equal(store.getLocationCapacity('L1').used, 64);

  // 64 个并发取消与查询交错；每次读取都必须看到完整状态
  const cancels = orderIds.map((id) => store.cancelOrder(id));
  for (let i = 0; i < 16; i += 1) {
    checkInvariants(store, orderIds, ['L1']);
  }
  await Promise.all(cancels);
  checkInvariants(store, orderIds, ['L1']);
  assert.equal(store.getLocationSku('L1', 'A').reserved, 0);
  assert.equal(store.getLocationCapacity('L1').used, 0);
  await store.close();
});

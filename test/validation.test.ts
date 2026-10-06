import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreError } from '../src/index.js';
import { openStore, checkInvariants } from './helpers.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof StoreError && err.code === code);
}

test('拆分数量与被拆单不完全相等时失败且状态不变', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);

  // 少拆
  await expectCode(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 4 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 4 }] },
    ]),
    'QUANTITY_MISMATCH',
  );
  // 多拆
  await expectCode(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 6 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 6 }] },
    ]),
    'QUANTITY_MISMATCH',
  );
  // 归属到不相关的原始订单
  await expectCode(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 5 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 5 }] },
    ]),
    'QUANTITY_MISMATCH',
  );
  assert.equal(store.getFulfillment(f1)?.status, 'active');
  assert.equal(store.getLocationSku('L1', 'A').reserved, 10);
  checkInvariants(store, ['O1'], ['L1']);
  await store.close();
});

test('拆分/合并的参数与状态校验', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 5 }]);

  // 拆分目标少于两张
  await expectCode(
    store.split(f1, [{ locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 10 }] }]),
    'INVALID_ARGUMENT',
  );
  // 合并输入少于两张 / 重复
  await expectCode(store.merge([f1], 'L1'), 'INVALID_ARGUMENT');
  await expectCode(store.merge([f1, f1], 'L1'), 'INVALID_ARGUMENT');
  // 未知履约单 / 未知地点 / 未知原始订单
  await expectCode(
    store.split('NOPE', [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 1 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 1 }] },
    ]),
    'FULFILLMENT_NOT_FOUND',
  );
  await expectCode(store.merge([f1, f2], 'NOPE'), 'LOCATION_NOT_FOUND');
  await expectCode(store.cancelOrder('NOPE'), 'ORDER_NOT_FOUND');
  await expectCode(store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 1 }]), 'ORDER_ALREADY_EXISTS');
  await expectCode(store.submitOrder('O9', 'NOPE', [{ sku: 'A', quantity: 1 }]), 'LOCATION_NOT_FOUND');
  await expectCode(store.configureLocation('L1', { capacity: 1, skus: {} }), 'INVALID_ARGUMENT');
  // 非法数量
  await expectCode(store.submitOrder('O8', 'L1', [{ sku: 'A', quantity: 0 }]), 'INVALID_ARGUMENT');
  await expectCode(
    store.split(f1, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: -1 }] },
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 11 }] },
    ]),
    'INVALID_ARGUMENT',
  );
  checkInvariants(store, ['O1', 'O2'], ['L1']);
  await store.close();
});

test('已失效履约单不能再次参与拆并', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 10 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 5 }]);
  const merged = await store.merge([f1, f2], 'L1');

  await expectCode(store.merge([f1, merged], 'L1'), 'FULFILLMENT_NOT_ACTIVE');
  await expectCode(
    store.split(f2, [
      { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 3 }] },
      { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 2 }] },
    ]),
    'FULFILLMENT_NOT_ACTIVE',
  );
  checkInvariants(store, ['O1', 'O2'], ['L1']);
  await store.close();
});

test('已取消订单不能被拆并操作重新带回', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 4 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 6 }]);
  const merged = await store.merge([f1, f2], 'L1');
  await store.cancelOrder('O1');

  // 合并单只剩 O2 的 6 件；试图把 O1 的 4 件拆回去必然与被拆单不符
  await expectCode(
    store.split(merged, [
      { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 4 }] },
      { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 6 }] },
    ]),
    'QUANTITY_MISMATCH',
  );
  // 合法拆分只含 O2 的数量
  const [t1, t2] = (await store.split(merged, [
    { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 2 }] },
    { locationId: 'L1', lines: [{ orderId: 'O2', sku: 'A', quantity: 4 }] },
  ])) as [string, string];
  assert.equal(store.getFulfillment(t1)?.status, 'active');
  assert.equal(store.getFulfillment(t2)?.status, 'active');
  checkInvariants(store, ['O1', 'O2'], ['L1']);
  await store.close();
});

test('取消只清空部分数量时合并单继续生效并占一个名额', async () => {
  const store = openStore();
  await store.configureLocation('L1', { capacity: 10, skus: { A: { total: 100, safetyStock: 0 } } });
  const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 4 }]);
  const f2 = await store.submitOrder('O2', 'L1', [{ sku: 'A', quantity: 6 }]);
  const merged = await store.merge([f1, f2], 'L1');

  await store.cancelOrder('O1');
  const view = store.getFulfillment(merged);
  assert.ok(view);
  assert.equal(view.status, 'active');
  assert.deepEqual(view.lines.get('A'), new Map([['O2', 6]]));
  assert.equal(store.getLocationCapacity('L1').used, 1);
  assert.equal(store.getLocationSku('L1', 'A').reserved, 6);

  // 再取消 O2：合并单变空，名额与库存全部释放
  await store.cancelOrder('O2');
  assert.equal(store.getFulfillment(merged)?.status, 'inactive');
  assert.equal(store.getLocationCapacity('L1').used, 0);
  assert.equal(store.getLocationSku('L1', 'A').reserved, 0);
  checkInvariants(store, ['O1', 'O2'], ['L1']);
  await store.close();
});

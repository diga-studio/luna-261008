import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderInventoryStore } from '../src/index.js';
import { makeStorePath, checkInvariants } from './helpers.js';

const LOCATIONS = 200;
const ORDERS = 20_000;
const CONCURRENCY = 64;

async function pooled<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}

test('规模：200 地点 / 2 万订单 / 2 万生效履约单 / 64 并发交错', async () => {
  const path = makeStorePath();
  const store = OrderInventoryStore.open({ filePath: path });
  const locationIds: string[] = [];
  for (let i = 0; i < LOCATIONS; i += 1) {
    locationIds.push(`L${i}`);
  }
  await Promise.all(
    locationIds.map((id) =>
      store.configureLocation(id, { capacity: 150, skus: { A: { total: 200, safetyStock: 10 } } }),
    ),
  );

  // 2 万张原始订单，64 并发提交，每地点 100 张
  const orderIds: string[] = [];
  const fulfillmentAt = new Map<string, string[]>();
  for (const id of locationIds) fulfillmentAt.set(id, []);
  for (let i = 0; i < ORDERS; i += 1) {
    orderIds.push(`O${i}`);
  }
  await pooled(orderIds, CONCURRENCY, async (orderId, i) => {
    const locationId = locationIds[i % LOCATIONS] as string;
    const fid = await store.submitOrder(orderId, locationId, [{ sku: 'A', quantity: 1 }]);
    (fulfillmentAt.get(locationId) as string[]).push(fid);
  });
  assert.equal(store.listActiveFulfillments().length, ORDERS);
  checkInvariants(store, orderIds, locationIds);

  // 每地点两两合并：1 万次合并，与查询交错
  const mergedIds: string[] = [];
  const pairs: [string, string, string][] = [];
  for (const [locationId, fids] of fulfillmentAt) {
    for (let i = 0; i < fids.length; i += 2) {
      pairs.push([fids[i] as string, fids[i + 1] as string, locationId]);
    }
  }
  await pooled(pairs, CONCURRENCY, async ([a, b, locationId]) => {
    const merged = await store.merge([a, b], locationId);
    mergedIds.push(merged);
    if (mergedIds.length % 200 === 0) {
      store.getLocationCapacity(locationId);
    }
  });
  assert.equal(store.listActiveFulfillments().length, ORDERS / 2);
  checkInvariants(store, orderIds, locationIds);

  // 原地拆回两张单：1 万次拆分（库存占用不变，仅名额变化）
  const splitIds: string[] = [];
  await pooled(mergedIds, CONCURRENCY, async (mergedId) => {
    const view = store.getFulfillment(mergedId);
    assert.ok(view);
    const lines = [...(view.lines.get('A') as Map<string, number>)];
    const [o1, o2] = lines as [[string, number], [string, number]];
    const [t1, t2] = (await store.split(mergedId, [
      { locationId: view.locationId, lines: [{ orderId: o1[0], sku: 'A', quantity: o1[1] }] },
      { locationId: view.locationId, lines: [{ orderId: o2[0], sku: 'A', quantity: o2[1] }] },
    ])) as [string, string];
    splitIds.push(t1, t2);
  });
  assert.equal(store.listActiveFulfillments().length, ORDERS);
  checkInvariants(store, orderIds, locationIds);

  // 取消一半订单：1 万次取消，与查询交错
  const cancelled = orderIds.filter((_, i) => i % 2 === 0);
  let cancelCount = 0;
  await pooled(cancelled, CONCURRENCY, async (orderId) => {
    await store.cancelOrder(orderId);
    cancelCount += 1;
    if (cancelCount % 500 === 0) {
      store.listActiveFulfillments();
    }
  });
  assert.equal(store.listActiveFulfillments().length, ORDERS / 2);
  checkInvariants(store, orderIds, locationIds);

  // 正常关闭后重开，状态不变
  await store.close();
  const reopened = OrderInventoryStore.open({ filePath: path });
  assert.equal(reopened.listActiveFulfillments().length, ORDERS / 2);
  checkInvariants(reopened, orderIds, locationIds);
  await reopened.close();
});

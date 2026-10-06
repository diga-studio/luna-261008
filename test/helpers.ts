import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderInventoryStore } from '../src/index.js';

export function makeStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ois-')), 'state.json');
}

export function openStore(): OrderInventoryStore {
  return OrderInventoryStore.open({ filePath: makeStorePath() });
}

/**
 * 从全部生效履约单独立汇总，核对：
 * - 每个未取消原始订单的各 SKU 数量之和等于提交量，取消后为零；
 * - 各地点的库存预留与容量占用恰好对应当前生效履约单，且不超限。
 */
export function checkInvariants(
  store: OrderInventoryStore,
  orderIds: string[],
  locationIds: string[],
): void {
  const actives = store.listActiveFulfillments();

  const orderTotals = new Map<string, Map<string, number>>();
  const locationReserved = new Map<string, Map<string, number>>();
  const locationSlots = new Map<string, number>();

  for (const f of actives) {
    assert.equal(f.status, 'active');
    locationSlots.set(f.locationId, (locationSlots.get(f.locationId) ?? 0) + 1);
    for (const [sku, perOrder] of f.lines) {
      let skuTotal = 0;
      for (const [orderId, qty] of perOrder) {
        assert.ok(qty > 0, 'fulfillment line quantity must be positive');
        skuTotal += qty;
        let perSku = orderTotals.get(orderId);
        if (!perSku) {
          perSku = new Map();
          orderTotals.set(orderId, perSku);
        }
        perSku.set(sku, (perSku.get(sku) ?? 0) + qty);
      }
      const reserved = locationReserved.get(f.locationId) ?? new Map<string, number>();
      reserved.set(sku, (reserved.get(sku) ?? 0) + skuTotal);
      locationReserved.set(f.locationId, reserved);
    }
  }

  for (const orderId of orderIds) {
    const order = store.getOrder(orderId);
    assert.ok(order, `order ${orderId} must exist`);
    const totals = orderTotals.get(orderId) ?? new Map<string, number>();
    if (order.status === 'cancelled') {
      assert.equal(totals.size, 0, `cancelled order ${orderId} must have zero reserved quantity`);
    } else {
      const expected = new Map(order.submitted);
      assert.deepEqual(totals, expected, `active order ${orderId} totals must equal submitted`);
    }
  }

  for (const locationId of locationIds) {
    const capacity = store.getLocationCapacity(locationId);
    const usedSlots = locationSlots.get(locationId) ?? 0;
    assert.equal(capacity.used, usedSlots, `location ${locationId} slot usage must match active fulfillments`);
    assert.ok(usedSlots <= capacity.capacity, `location ${locationId} capacity exceeded`);
    const reserved = locationReserved.get(locationId) ?? new Map<string, number>();
    const skus = new Set<string>(reserved.keys());
    for (const sku of skus) {
      const view = store.getLocationSku(locationId, sku);
      assert.equal(view.reserved, reserved.get(sku) ?? 0, `location ${locationId} sku ${sku} reserved must match`);
      assert.ok(view.reserved <= view.total - view.safetyStock, `location ${locationId} sku ${sku} stock exceeded`);
    }
  }
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderInventoryService } from '../src/service';
import { SkuQuantities } from '../src/types';

export interface TempService {
  service: OrderInventoryService;
  dbPath: string;
  dir: string;
  cleanup: () => void;
}

export function openService(dbPath?: string): TempService {
  const dir = mkdtempSync(join(tmpdir(), 'ois-test-'));
  const file = dbPath ?? join(dir, 'data.db');
  const service = new OrderInventoryService(file);
  return {
    service,
    dbPath: file,
    dir,
    cleanup: () => {
      try {
        service.close();
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 从全部生效履约单独立汇总，核对：
 * - 每个未取消原始订单的各 SKU 数量之和等于提交量，已取消订单为零
 * - 各地点的库存预留与容量占用恰好对应当前生效履约单，且不超约束
 */
export function assertConsistent(
  service: OrderInventoryService,
  submitted: Map<string, SkuQuantities>,
  canceled: Set<string>,
  locations: Array<{ locationId: string; capacity: number; inventory: Record<string, { total: number; safetyStock: number }> }>,
): void {
  const active = service.listActiveFulfillments();

  // 独立汇总：订单维度
  const orderSums = new Map<string, SkuQuantities>();
  for (const fo of active) {
    assert.equal(fo.status, 'active');
    assert.ok(Object.keys(fo.lines).length > 0, `active fulfillment ${fo.id} must not be empty`);
    for (const orderId of Object.keys(fo.lines)) {
      let entry = orderSums.get(orderId);
      if (!entry) {
        entry = {};
        orderSums.set(orderId, entry);
      }
      for (const sku of Object.keys(fo.lines[orderId])) {
        entry[sku] = (entry[sku] ?? 0) + fo.lines[orderId][sku];
      }
    }
  }
  for (const [orderId, quantities] of submitted) {
    const expect: SkuQuantities = canceled.has(orderId) ? {} : quantities;
    assert.deepEqual(
      orderSums.get(orderId) ?? {},
      expect,
      `order ${orderId} quantities mismatch`,
    );
    assert.deepEqual(service.getOrderQuantities(orderId), expect);
  }
  for (const orderId of orderSums.keys()) {
    assert.ok(submitted.has(orderId), `orphan reservation for order ${orderId}`);
    assert.ok(!canceled.has(orderId), `canceled order ${orderId} still reserved`);
  }

  // 独立汇总：地点维度
  for (const loc of locations) {
    const reserved: SkuQuantities = {};
    let count = 0;
    for (const fo of active) {
      if (fo.locationId !== loc.locationId) continue;
      count += 1;
      for (const orderId of Object.keys(fo.lines)) {
        for (const sku of Object.keys(fo.lines[orderId])) {
          reserved[sku] = (reserved[sku] ?? 0) + fo.lines[orderId][sku];
        }
      }
    }
    const usage = service.getLocationUsage(loc.locationId);
    assert.ok(usage, `location ${loc.locationId} missing`);
    assert.equal(usage!.activeFulfillments, count, `location ${loc.locationId} capacity usage`);
    assert.deepEqual(usage!.reserved, reserved, `location ${loc.locationId} reserved mismatch`);
    assert.ok(count <= loc.capacity, `location ${loc.locationId} capacity exceeded`);
    for (const sku of Object.keys(reserved)) {
      const stock = loc.inventory[sku];
      const available = stock ? stock.total - stock.safetyStock : 0;
      assert.ok(reserved[sku] <= available, `location ${loc.locationId} sku ${sku} over-reserved`);
    }
  }
}

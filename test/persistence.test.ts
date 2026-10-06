import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderInventoryService } from '../src/service';
import { assertConsistent } from './helpers';
import { SkuQuantities } from '../src/types';

const LOCS = [
  { locationId: 'L1', capacity: 10, inventory: { A: { total: 100, safetyStock: 5 }, B: { total: 50, safetyStock: 0 } } },
  { locationId: 'L2', capacity: 10, inventory: { A: { total: 100, safetyStock: 5 }, B: { total: 50, safetyStock: 0 } } },
];

test('正常关闭后重新打开，订单归属与资源占用不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ois-persist-'));
  const dbPath = join(dir, 'data.db');
  const submitted = new Map<string, SkuQuantities>([
    ['O1', { A: 30, B: 5 }],
    ['O2', { A: 40 }],
    ['O3', { B: 10 }],
  ]);
  const canceled = new Set<string>(['O3']);

  let snapshotActive: ReturnType<OrderInventoryService['listActiveFulfillments']>;
  let mergedId: string;
  {
    const service = new OrderInventoryService(dbPath);
    for (const loc of LOCS) {
      assert.ok(service.configureLocation(loc.locationId, loc.capacity, loc.inventory).ok);
    }
    const fo1 = service.submitOrder('O1', 'L1', { A: 30, B: 5 });
    const fo2 = service.submitOrder('O2', 'L1', { A: 40 });
    const fo3 = service.submitOrder('O3', 'L2', { B: 10 });
    assert.ok(fo1.ok && fo2.ok && fo3.ok);

    const merged = service.merge([fo1.value, fo2.value], 'L2');
    assert.ok(merged.ok);
    mergedId = merged.value;
    const split = service.split(fo3.value, [
      { locationId: 'L1', lines: [{ orderId: 'O3', quantities: { B: 4 } }] },
      { locationId: 'L2', lines: [{ orderId: 'O3', quantities: { B: 6 } }] },
    ]);
    assert.ok(split.ok);
    assert.ok(service.cancelOrder('O3').ok);
    assertConsistent(service, submitted, canceled, LOCS);
    snapshotActive = service.listActiveFulfillments();
    service.close();
  }

  // 重新打开：状态完全一致
  {
    const service = new OrderInventoryService(dbPath);
    assert.deepEqual(service.listActiveFulfillments(), snapshotActive);
    assert.deepEqual(service.getOrderQuantities('O1'), { A: 30, B: 5 });
    assert.deepEqual(service.getOrderQuantities('O2'), { A: 40 });
    assert.deepEqual(service.getOrderQuantities('O3'), {});
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, {});
    assert.deepEqual(service.getLocationUsage('L2')!.reserved, { A: 70, B: 5 });
    assert.equal(service.getLocationUsage('L2')!.activeFulfillments, 1);
    assertConsistent(service, submitted, canceled, LOCS);

    // 重开后仍可继续操作：重复取消不释放、重复提交被拒绝、拆并正常
    assert.ok(service.cancelOrder('O3').ok);
    assert.ok(!service.submitOrder('O1', 'L1', { A: 1 }).ok);
    const split = service.split(mergedId, [
      { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 30, B: 5 } }] },
      { locationId: 'L2', lines: [{ orderId: 'O2', quantities: { A: 40 } }] },
    ]);
    assert.ok(split.ok, split.ok ? '' : split.error);
    assertConsistent(service, submitted, canceled, LOCS);
    service.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

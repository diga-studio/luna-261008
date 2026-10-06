import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openService, assertConsistent } from './helpers';
import { SkuQuantities } from '../src/types';

test('规模冒烟：200 个地点、2000 张订单上的混合操作后不变量成立', () => {
  const locations = Array.from({ length: 200 }, (_, i) => ({
    locationId: `L${i}`,
    capacity: 50,
    inventory: { A: { total: 10000, safetyStock: 10 } },
  }));
  const { service, cleanup } = openService();
  try {
    for (const loc of locations) {
      assert.ok(service.configureLocation(loc.locationId, loc.capacity, loc.inventory).ok);
    }
    const submitted = new Map<string, SkuQuantities>();
    const canceled = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const orderId = `O${i}`;
      submitted.set(orderId, { A: 2 });
      const r = service.submitOrder(orderId, `L${i % 200}`, { A: 2 });
      assert.ok(r.ok);
    }
    // 每地点合并若干单、再拆分、再取消部分订单
    for (let round = 0; round < 200; round++) {
      const active = service.listActiveFulfillments().filter((f) => f.locationId === `L${round}`);
      if (active.length >= 2) {
        const merged = service.merge([active[0].id, active[1].id], `L${round}`);
        assert.ok(merged.ok);
        const mergedFo = service.getFulfillment(merged.value)!;
        const orderIds = Object.keys(mergedFo.lines);
        if (orderIds.length === 2) {
          const [a, b] = orderIds;
          const split = service.split(merged.value, [
            { locationId: `L${round}`, lines: [{ orderId: a, quantities: { ...mergedFo.lines[a] } }] },
            { locationId: `L${(round + 1) % 200}`, lines: [{ orderId: b, quantities: { ...mergedFo.lines[b] } }] },
          ]);
          assert.ok(split.ok);
        }
      }
      const victim = `O${round * 10}`;
      if (submitted.has(victim) && !canceled.has(victim)) {
        service.cancelOrder(victim);
        canceled.add(victim);
      }
    }
    assertConsistent(service, submitted, canceled, locations);
  } finally {
    cleanup();
  }
});

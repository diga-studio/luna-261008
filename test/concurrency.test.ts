import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openService, assertConsistent } from './helpers';
import { SkuQuantities } from '../src/types';

const LOCS = [
  { locationId: 'L1', capacity: 100, inventory: { A: { total: 100000, safetyStock: 0 } } },
  { locationId: 'L2', capacity: 100, inventory: { A: { total: 100000, safetyStock: 0 } } },
];

function setup() {
  const ctx = openService();
  ctx.service.configureLocation('L1', 100, { A: { total: 100000, safetyStock: 0 } });
  ctx.service.configureLocation('L2', 100, { A: { total: 100000, safetyStock: 0 } });
  return ctx;
}

/** 让异步任务交错调度（本库方法均为同步原子操作，交错点只可能出现在两次调用之间） */
function defer(fn: () => void): Promise<void> {
  return new Promise((resolve) => setImmediate(() => {
    fn();
    resolve();
  }));
}

test('同一履约单的拆分与其原始订单取消并发：最终状态对应某种完整串行顺序', async () => {
  const { service, cleanup } = setup();
  try {
    const submitted = new Map<string, SkuQuantities>([['O1', { A: 60 }]]);
    const canceled = new Set<string>();
    const fo = service.submitOrder('O1', 'L1', { A: 60 });
    assert.ok(fo.ok);

    let splitResult: string[] | null = null;
    await Promise.all([
      defer(() => {
        const r = service.split(fo.value, [
          { locationId: 'L1', lines: [{ orderId: 'O1', quantities: { A: 20 } }] },
          { locationId: 'L2', lines: [{ orderId: 'O1', quantities: { A: 40 } }] },
        ]);
        if (r.ok) splitResult = r.value;
      }),
      defer(() => {
        service.cancelOrder('O1');
        canceled.add('O1');
      }),
    ]);

    if (splitResult === null) {
      // 串行顺序：先取消（履约单变空失效）→ 拆分失败
      assert.equal(service.getFulfillment(fo.value)!.status, 'inactive');
      assert.equal(service.listActiveFulfillments().length, 0);
    } else {
      // 串行顺序：先拆分成功 → 取消作用于两张新单，二者变空失效
      assert.equal(service.getFulfillment(fo.value)!.status, 'inactive');
      const children = splitResult as unknown as string[];
      assert.equal(children.length, 2);
      for (const id of children) {
        assert.equal(service.getFulfillment(id)!.status, 'inactive');
      }
      assert.equal(service.listActiveFulfillments().length, 0);
    }
    assert.deepEqual(service.getOrderQuantities('O1'), {});
    assert.deepEqual(service.getLocationUsage('L1')!.reserved, {});
    assert.deepEqual(service.getLocationUsage('L2')!.reserved, {});
    assert.equal(service.getLocationUsage('L1')!.activeFulfillments, 0);
    assert.equal(service.getLocationUsage('L2')!.activeFulfillments, 0);
    assertConsistent(service, submitted, canceled, LOCS);
  } finally {
    cleanup();
  }
});

test('64 个并发调用交错执行拆并、取消与查询，不变量始终成立', async () => {
  const { service, cleanup } = setup();
  try {
    const submitted = new Map<string, SkuQuantities>();
    const canceled = new Set<string>();
    const fos: string[] = [];
    for (let i = 0; i < 20; i++) {
      const orderId = `O${i}`;
      submitted.set(orderId, { A: 10 });
      const r = service.submitOrder(orderId, 'L1', { A: 10 });
      assert.ok(r.ok);
      fos.push(r.value);
    }

    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < 64; i++) {
      tasks.push(
        defer(() => {
          const pick = i % 4;
          if (pick === 0) {
            // 取消一个尚未取消的订单（若有）
            for (const orderId of submitted.keys()) {
              if (!canceled.has(orderId)) {
                service.cancelOrder(orderId);
                canceled.add(orderId);
                break;
              }
            }
          } else if (pick === 1) {
            // 尝试合并前两单（可能已失效，失败也可接受）
            service.merge(fos.slice(0, 2), 'L2');
          } else if (pick === 2) {
            // 尝试拆分任意一张生效单
            const active = service.listActiveFulfillments();
            if (active.length > 0) {
              const target = active[0];
              const orderIds = Object.keys(target.lines);
              const first = orderIds[0];
              const sku = Object.keys(target.lines[first])[0];
              const qty = target.lines[first][sku];
              if (qty >= 2) {
                service.split(target.id, [
                  { locationId: target.locationId, lines: [{ orderId: first, quantities: { [sku]: 1 } }] },
                  {
                    locationId: target.locationId,
                    lines: [
                      { orderId: first, quantities: { [sku]: qty - 1 } },
                      ...orderIds.slice(1).map((oid) => ({ orderId: oid, quantities: { ...target.lines[oid] } })),
                    ],
                  },
                ]);
              }
            }
          } else {
            // 查询：任何一次读取只能看到完整状态
            const usage = service.getLocationUsage('L1')!;
            assert.ok(usage.activeFulfillments <= 100);
            assertConsistent(service, submitted, canceled, LOCS);
          }
        }),
      );
    }
    await Promise.all(tasks);
    assertConsistent(service, submitted, canceled, LOCS);
  } finally {
    cleanup();
  }
});

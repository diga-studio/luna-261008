import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelAvailability } from '../src/index.js';
import type { StateRecord } from '../src/index.js';

interface TestTunnel {
  id: string;
  siteA: string;
  siteB: string;
  ifaceA: string;
  ifaceB: string;
}

/**
 * 独立参考实现：对窗口内每一毫秒，重放全部记录
 * （按 recordId 去重、同对象同毫秒取最大 seq）计算是否可连通。
 */
function referenceConnectedMs(
  tunnels: TestTunnel[],
  records: StateRecord[],
  siteA: string,
  siteB: string,
  windowStart: number,
  windowEnd: number,
): number {
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    if (seen.has(r.recordId)) return false;
    seen.add(r.recordId);
    return true;
  });
  const pair = tunnels.filter(
    (t) =>
      (t.siteA === siteA && t.siteB === siteB) || (t.siteA === siteB && t.siteB === siteA),
  );
  let connected = 0;
  for (let t = windowStart; t < windowEnd; t += 1) {
    const stateOf = (objectType: string, objectId: string): string | undefined => {
      let best: StateRecord | undefined;
      for (const r of unique) {
        if (r.objectType !== objectType || r.objectId !== objectId || r.bizTime > t) continue;
        if (!best || r.bizTime > best.bizTime || (r.bizTime === best.bizTime && r.seq > best.seq)) {
          best = r;
        }
      }
      return best?.state;
    };
    const ok = pair.some(
      (tn) =>
        stateOf('tunnel', tn.id) === 'Active' &&
        stateOf('interface', tn.ifaceA) === 'up' &&
        stateOf('interface', tn.ifaceB) === 'up',
    );
    if (ok) connected += 1;
  }
  return connected;
}

function rec(
  recordId: string,
  objectType: 'interface' | 'tunnel',
  objectId: string,
  seq: number,
  bizTime: number,
  state: string,
): StateRecord {
  return { recordId, objectType, objectId, seq, bizTime, state };
}

test('共享接口故障影响所有隧道，并行隧道同毫秒接力无虚假间隙', () => {
  const stats = new TunnelAvailability(':memory:');
  // t1 与 t2 共享接口 ia1
  stats.addTunnel('t1', 'A', 'B', 'ia1', 'ib1');
  stats.addTunnel('t2', 'A', 'B', 'ia1', 'ib2');

  const records: StateRecord[] = [
    rec('r1', 'interface', 'ia1', 1, 0, 'up'),
    rec('r2', 'interface', 'ib1', 1, 0, 'up'),
    rec('r3', 'interface', 'ib2', 1, 0, 'up'),
    rec('r4', 'tunnel', 't1', 1, 0, 'Active'),
    rec('r5', 'tunnel', 't2', 1, 0, 'Inactive'),
    // 同一毫秒：t1 退出 Active，t2 进入 Active —— 接力，不得产生间隙
    rec('r6', 'tunnel', 't1', 2, 300, 'Maintenance'),
    rec('r7', 'tunnel', 't2', 2, 300, 'Active'),
    // 共享接口 ia1 故障：t1、t2 同时失效
    rec('r8', 'interface', 'ia1', 2, 600, 'down'),
    rec('r9', 'interface', 'ia1', 3, 800, 'up'),
  ];
  for (const r of records) stats.appendRecord(r);

  const report = stats.report('A', 'B', 0, 1000);
  // [0,600) 全程可连通（300ms 处接力无间隙）+ [800,1000) = 600 + 200
  assert.equal(report.connectedMs, 800);
  assert.equal(report.availability, 0.8);

  const tunnels: TestTunnel[] = [
    { id: 't1', siteA: 'A', siteB: 'B', ifaceA: 'ia1', ifaceB: 'ib1' },
    { id: 't2', siteA: 'A', siteB: 'B', ifaceA: 'ia1', ifaceB: 'ib2' },
  ];
  assert.equal(report.connectedMs, referenceConnectedMs(tunnels, records, 'A', 'B', 0, 1000));
  // 无方向：站点对顺序不影响结果
  assert.equal(stats.report('B', 'A', 0, 1000).connectedMs, 800);
  stats.close();
});

test('乱序、重复、迟到记录与同毫秒序号决胜', () => {
  const stats = new TunnelAvailability(':memory:');
  stats.addTunnel('t1', 'A', 'B', 'ia', 'ib');

  const tunnels: TestTunnel[] = [
    { id: 't1', siteA: 'A', siteB: 'B', ifaceA: 'ia', ifaceB: 'ib' },
  ];
  const arrived: StateRecord[] = [];
  const arrive = (r: StateRecord) => {
    stats.appendRecord(r);
    arrived.push(r);
  };

  // 乱序到达
  arrive(rec('n2', 'interface', 'ia', 1, 100, 'up'));
  arrive(rec('n1', 'interface', 'ib', 1, 100, 'up'));
  arrive(rec('n4', 'tunnel', 't1', 1, 100, 'Active'));
  // 重复到达：内容相同，只生效一次
  arrive(rec('n2', 'interface', 'ia', 1, 100, 'up'));
  arrive(rec('n3', 'interface', 'ia', 2, 500, 'down'));

  const first = stats.report('A', 'B', 0, 1000);
  assert.equal(first.connectedMs, 400); // [100,500)
  assert.equal(first.connectedMs, referenceConnectedMs(tunnels, arrived, 'A', 'B', 0, 1000));

  // 迟到记录改变已查询过的历史窗口
  arrive(rec('n5', 'tunnel', 't1', 2, 200, 'Inactive'));
  const second = stats.report('A', 'B', 0, 1000);
  assert.equal(second.connectedMs, 100); // 只剩 [100,200)
  assert.equal(second.connectedMs, referenceConnectedMs(tunnels, arrived, 'A', 'B', 0, 1000));

  // 同一对象同一毫秒多条记录：序号最大者为准，与到达顺序无关
  arrive(rec('n6', 'interface', 'ib', 9, 700, 'down'));
  arrive(rec('n7', 'interface', 'ib', 5, 700, 'up')); // 序号更小，后到也不生效
  const third = stats.report('A', 'B', 0, 1000);
  assert.equal(third.connectedMs, referenceConnectedMs(tunnels, arrived, 'A', 'B', 0, 1000));
  // 700ms 起 ib 为 down（seq 9 胜出），窗口内连通区间不变
  assert.equal(third.connectedMs, 100);
  stats.close();
});

test('窗口前状态延续进窗口，跨界故障只算窗口内部分', () => {
  const stats = new TunnelAvailability(':memory:');
  stats.addTunnel('t1', 'A', 'B', 'ia', 'ib');
  const records: StateRecord[] = [
    rec('r1', 'interface', 'ia', 1, 0, 'up'),
    rec('r2', 'interface', 'ib', 1, 0, 'up'),
    rec('r3', 'tunnel', 't1', 1, 0, 'Active'),
    rec('r4', 'interface', 'ia', 2, 500, 'down'),
    rec('r5', 'interface', 'ia', 3, 1500, 'up'),
  ];
  for (const r of records) stats.appendRecord(r);

  // 故障 [500,1500) 跨越窗口起点；窗口 [1000,2000) 内只有 [1500,2000) 可连通
  const report = stats.report('A', 'B', 1000, 2000);
  assert.equal(report.connectedMs, 500);
  assert.equal(report.availability, 0.5);

  const tunnels: TestTunnel[] = [
    { id: 't1', siteA: 'A', siteB: 'B', ifaceA: 'ia', ifaceB: 'ib' },
  ];
  assert.equal(report.connectedMs, referenceConnectedMs(tunnels, records, 'A', 'B', 1000, 2000));
  stats.close();
});

test('首条记录之前一律不可用；无隧道站点对可用率为零', () => {
  const stats = new TunnelAvailability(':memory:');
  stats.addTunnel('t1', 'A', 'B', 'ia', 'ib');
  stats.appendRecord(rec('r1', 'interface', 'ia', 1, 1000, 'up'));
  stats.appendRecord(rec('r2', 'interface', 'ib', 1, 1000, 'up'));
  stats.appendRecord(rec('r3', 'tunnel', 't1', 1, 1000, 'Active'));

  assert.equal(stats.report('A', 'B', 0, 1000).connectedMs, 0);
  assert.equal(stats.report('A', 'B', 1000, 2000).connectedMs, 1000);
  assert.equal(stats.report('A', 'C', 0, 2000).connectedMs, 0);
  assert.equal(stats.report('A', 'C', 0, 2000).availability, 0);
  stats.close();
});

test('拓扑与记录持久化在 SQLite 文件中', () => {
  const path = `/private/tmp/tunnel-availability-test-${process.pid}.sqlite`;
  const stats = new TunnelAvailability(path);
  stats.addTunnel('t1', 'A', 'B', 'ia', 'ib');
  stats.appendRecord(rec('r1', 'interface', 'ia', 1, 0, 'up'));
  stats.appendRecord(rec('r2', 'interface', 'ib', 1, 0, 'up'));
  stats.appendRecord(rec('r3', 'tunnel', 't1', 1, 0, 'Active'));
  stats.close();

  const reopened = new TunnelAvailability(path);
  assert.equal(reopened.report('A', 'B', 0, 100).connectedMs, 100);
  reopened.close();
});

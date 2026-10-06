import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AgentStore } from '../src/agent';
import { AggregatorStore } from '../src/aggregator';
import { makePayload, rmDir, shuffled, syncOnce, syncUntilSettled, tmpDir } from './helpers';

/** 校验汇总记录与期望事件按序号逐字节一致、无重复无缺口。 */
function assertRecordsMatch(agg: AggregatorStore, agentId: string, expected: Map<string, Buffer>): void {
  const records = agg.records(agentId);
  assert.equal(records.length, expected.size, '记录数量应与接收成功的事件数一致');
  const byEventId = new Map(records.map((r) => [r.eventId, r]));
  for (const [eventId, payload] of expected) {
    const rec = byEventId.get(eventId);
    assert.ok(rec, `缺少事件 ${eventId}`);
    assert.ok(rec.payload.equals(payload), `事件 ${eventId} 正文不一致`);
  }
  for (let i = 0; i < records.length; i++) {
    assert.equal(records[i].seq, i + 1, '序号必须从 1 开始连续无缺口');
  }
  assert.equal(agg.watermark(agentId), expected.size);
}

test('汇总侧不可用时代理照常接收；恢复后乱序分批补传最终一致', () => {
  const dir = tmpDir('sentinel-sync-');
  try {
    const agent = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    const expected = new Map<string, Buffer>();
    // 汇总侧“不可用”期间，代理持续接收并返回成功
    for (let i = 1; i <= 50; i++) {
      const payload = makePayload(i);
      const r = agent.receiveEvent(`evt-${i}`, payload);
      assert.equal(r.seq, i);
      expected.set(`evt-${i}`, payload);
    }

    const agg = new AggregatorStore(path.join(dir, 'agg.db'));
    // 连接恢复：每批只送 7 条、乱序、最终全部汇总成功
    syncUntilSettled(agent, agg, { batchSize: 7, shuffle: true });
    assertRecordsMatch(agg, 'agent-1', expected);
    assert.equal(agent.pendingEvents().length, 0, '全部确认后正文已清理');

    agent.close();
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('回执丢失导致重复补传：汇总侧去重，最终一致', () => {
  const dir = tmpDir('sentinel-sync-');
  try {
    const agent = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    const expected = new Map<string, Buffer>();
    for (let i = 1; i <= 20; i++) {
      const payload = makePayload(i);
      agent.receiveEvent(`evt-${i}`, payload);
      expected.set(`evt-${i}`, payload);
    }
    const agg = new AggregatorStore(path.join(dir, 'agg.db'));

    // 前几轮回执全部丢失：汇总侧已保存，代理不知情而重传
    for (let i = 0; i < 3; i++) {
      syncOnce(agent, agg, { batchSize: 6, shuffle: true, dropAcks: true });
    }
    assert.equal(agent.pendingEvents().length, 20, '回执丢失时代理不得清理正文');

    // 回执恢复后最终收敛
    syncUntilSettled(agent, agg, { batchSize: 5, shuffle: true });
    assertRecordsMatch(agg, 'agent-1', expected);

    agent.close();
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('两侧分别重启后恢复补传，最终记录逐字节一致', () => {
  const dir = tmpDir('sentinel-sync-');
  try {
    const agentDb = path.join(dir, 'agent.db');
    const aggDb = path.join(dir, 'agg.db');
    const expected = new Map<string, Buffer>();

    let agent = new AgentStore(agentDb, 'agent-1');
    let agg = new AggregatorStore(aggDb);
    for (let i = 1; i <= 30; i++) {
      const payload = makePayload(i);
      agent.receiveEvent(`evt-${i}`, payload);
      expected.set(`evt-${i}`, payload);
    }
    // 部分补传后两侧同时“重启”
    syncOnce(agent, agg, { batchSize: 10, shuffle: true });
    agent.close();
    agg.close();

    // 仅汇总侧先恢复，代理继续接收新事件
    agg = new AggregatorStore(aggDb);
    agent = new AgentStore(agentDb, 'agent-1');
    for (let i = 31; i <= 40; i++) {
      const payload = makePayload(i);
      agent.receiveEvent(`evt-${i}`, payload);
      expected.set(`evt-${i}`, payload);
    }
    syncOnce(agent, agg, { batchSize: 8, shuffle: true, dropAcks: true });
    agent.close();
    agg.close();

    // 两侧再次恢复，持续补传直至收敛
    agent = new AgentStore(agentDb, 'agent-1');
    agg = new AggregatorStore(aggDb);
    syncUntilSettled(agent, agg, { batchSize: 6, shuffle: true });
    assertRecordsMatch(agg, 'agent-1', expected);
    assert.equal(agent.ackWatermark(), 40);

    agent.close();
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('已清理事件再次提交不会新增汇总记录', () => {
  const dir = tmpDir('sentinel-sync-');
  try {
    const agent = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    const expected = new Map<string, Buffer>();
    for (let i = 1; i <= 10; i++) {
      const payload = makePayload(i);
      agent.receiveEvent(`evt-${i}`, payload);
      expected.set(`evt-${i}`, payload);
    }
    const agg = new AggregatorStore(path.join(dir, 'agg.db'));
    syncUntilSettled(agent, agg, { shuffle: true });
    assert.equal(agent.pendingEvents().length, 0, '正文已清理');

    // 调用方用原标识和正文重试已清理的事件
    for (let i = 1; i <= 10; i++) {
      const r = agent.receiveEvent(`evt-${i}`, makePayload(i));
      assert.equal(r.isNew, false);
      assert.equal(r.seq, i);
    }
    // 代理侧没有可补传的东西，汇总记录不变
    syncOnce(agent, agg);
    assertRecordsMatch(agg, 'agent-1', expected);

    agent.close();
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('两个代理交错补传（端到端）：缺口隔离与最终一致', () => {
  const dir = tmpDir('sentinel-sync-');
  try {
    const agentA = new AgentStore(path.join(dir, 'agentA.db'), 'A');
    const agentB = new AgentStore(path.join(dir, 'agentB.db'), 'B');
    const expectedA = new Map<string, Buffer>();
    const expectedB = new Map<string, Buffer>();
    for (let i = 1; i <= 4; i++) {
      const pa = makePayload(100 + i);
      const pb = makePayload(200 + i);
      agentA.receiveEvent(`a-evt-${i}`, pa);
      agentB.receiveEvent(`b-evt-${i}`, pb);
      expectedA.set(`a-evt-${i}`, pa);
      expectedB.set(`b-evt-${i}`, pb);
    }
    const agg = new AggregatorStore(path.join(dir, 'agg.db'));

    // B 的 3、4 先送达（乱序），A 的 1、2 正常送达
    const bPending = agentB.pendingEvents();
    const bFirst = shuffled(bPending.filter((e) => e.seq >= 3), 7);
    const acksB1 = agg.applyEvents(bFirst);
    const acksA1 = agg.applyEvents(agentA.pendingEvents(2));
    for (const ack of [...acksB1, ...acksA1]) {
      (ack.agentId === 'A' ? agentA : agentB).applyAck(ack);
    }

    assert.equal(agg.watermark('B'), 0, 'B 存在缺口，不能展示任何记录');
    assert.deepEqual(agg.records('B'), []);
    assert.equal(agg.watermark('A'), 2, 'A 的确认进度不受 B 影响');
    assert.equal(agentA.ackWatermark(), 2);
    assert.equal(agentB.ackWatermark(), 0);

    // B 的 1、2 随后送达，缺口补齐
    syncUntilSettled(agentB, agg, { shuffle: true });
    syncUntilSettled(agentA, agg, { shuffle: true });

    // 两侧与汇总都重启后，完整记录与连续确认水位保持正确
    agentA.close();
    agentB.close();
    agg.close();
    const agentA2 = new AgentStore(path.join(dir, 'agentA.db'), 'A');
    const agentB2 = new AgentStore(path.join(dir, 'agentB.db'), 'B');
    const agg2 = new AggregatorStore(path.join(dir, 'agg.db'));

    assertRecordsMatch(agg2, 'A', expectedA);
    assertRecordsMatch(agg2, 'B', expectedB);
    assert.equal(agentA2.ackWatermark(), 4);
    assert.equal(agentB2.ackWatermark(), 4);

    agentA2.close();
    agentB2.close();
    agg2.close();
  } finally {
    rmDir(dir);
  }
});

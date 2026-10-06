import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AgentStore } from '../src/agent';
import { makePayload, rmDir, tmpDir } from './helpers';

test('序号从 1 开始连续递增，同一事件标识重复提交返回原序号', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const store = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    const r1 = store.receiveEvent('evt-a', makePayload(1));
    const r2 = store.receiveEvent('evt-b', makePayload(2));
    const r3 = store.receiveEvent('evt-c', makePayload(3));
    assert.deepEqual([r1.seq, r2.seq, r3.seq], [1, 2, 3]);
    assert.ok(r1.isNew && r2.isNew && r3.isNew);

    const dup = store.receiveEvent('evt-b', makePayload(2));
    assert.equal(dup.seq, 2);
    assert.equal(dup.isNew, false);
    assert.equal(store.lastSeq(), 3);
    assert.equal(store.pendingEvents().length, 3);
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('重启后事件正文与序号可恢复，原标识重试不产生重复或缺口', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const dbPath = path.join(dir, 'agent.db');
    let store = new AgentStore(dbPath, 'agent-1');
    store.receiveEvent('evt-1', makePayload(1));
    store.receiveEvent('evt-2', makePayload(2));
    store.close();

    store = new AgentStore(dbPath, 'agent-1');
    assert.equal(store.lastSeq(), 2);
    const retry = store.receiveEvent('evt-2', makePayload(2));
    assert.equal(retry.seq, 2);
    assert.equal(retry.isNew, false);
    const r3 = store.receiveEvent('evt-3', makePayload(3));
    assert.equal(r3.seq, 3, '重试后新事件应紧接着分配序号 3，无缺口');

    const pending = store.pendingEvents();
    assert.deepEqual(pending.map((e) => e.seq), [1, 2, 3]);
    assert.ok(pending[0].payload.equals(makePayload(1)));
    assert.ok(pending[1].payload.equals(makePayload(2)));
    assert.ok(pending[2].payload.equals(makePayload(3)));
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('确认水位只增不减，水位以内正文被清理，过期回执不倒退', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const store = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    for (let i = 1; i <= 5; i++) {
      store.receiveEvent(`evt-${i}`, makePayload(i));
    }
    store.applyAck({ agentId: 'agent-1', watermark: 3 });
    assert.equal(store.ackWatermark(), 3);
    assert.deepEqual(store.pendingEvents().map((e) => e.seq), [4, 5]);

    // 延迟到达的旧回执不能使确认进度倒退
    store.applyAck({ agentId: 'agent-1', watermark: 1 });
    assert.equal(store.ackWatermark(), 3);
    assert.deepEqual(store.pendingEvents().map((e) => e.seq), [4, 5]);

    // 其他代理的回执被忽略
    store.applyAck({ agentId: 'agent-2', watermark: 5 });
    assert.equal(store.ackWatermark(), 3);
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('清理正文后再次接收同一事件标识仍返回原序号，且不重新进入待补传', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const store = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    store.receiveEvent('evt-1', makePayload(1));
    store.receiveEvent('evt-2', makePayload(2));
    store.applyAck({ agentId: 'agent-1', watermark: 2 });
    assert.equal(store.pendingEvents().length, 0);

    const again = store.receiveEvent('evt-1', makePayload(1));
    assert.equal(again.seq, 1);
    assert.equal(again.isNew, false);
    assert.equal(store.pendingEvents().length, 0, '已清理的旧事件不能重新补传');
    assert.equal(store.lastSeq(), 2, '不能产生新序号');
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('确认与清理状态在重启后保持', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const dbPath = path.join(dir, 'agent.db');
    let store = new AgentStore(dbPath, 'agent-1');
    for (let i = 1; i <= 4; i++) {
      store.receiveEvent(`evt-${i}`, makePayload(i));
    }
    store.applyAck({ agentId: 'agent-1', watermark: 2 });
    store.close();

    store = new AgentStore(dbPath, 'agent-1');
    assert.equal(store.ackWatermark(), 2);
    assert.deepEqual(store.pendingEvents().map((e) => e.seq), [3, 4]);
    const again = store.receiveEvent('evt-1', makePayload(1));
    assert.equal(again.seq, 1);
    assert.equal(again.isNew, false);
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('支持积压 10000 条 4KiB 事件，确认后正文释放、未确认不清理', () => {
  const dir = tmpDir('sentinel-agent-');
  try {
    const store = new AgentStore(path.join(dir, 'agent.db'), 'agent-1');
    const total = 10000;
    for (let i = 1; i <= total; i++) {
      store.receiveEvent(`evt-${i}`, makePayload(i));
    }
    assert.equal(store.lastSeq(), total);
    assert.equal(store.pendingEvents(total).length, total);

    store.applyAck({ agentId: 'agent-1', watermark: 6000 });
    assert.equal(store.pendingEvents(total).length, 4000, '未确认的正文不得被清理');

    // 抽查已清理事件重提仍返回原序号
    const again = store.receiveEvent('evt-100', makePayload(100));
    assert.equal(again.seq, 100);
    assert.equal(again.isNew, false);
    store.close();
  } finally {
    rmDir(dir);
  }
});

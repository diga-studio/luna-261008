import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AggregatorStore } from '../src/aggregator';
import { EventEnvelope } from '../src/types';
import { makePayload, rmDir, tmpDir } from './helpers';

function env(agentId: string, seq: number, eventId?: string): EventEnvelope {
  return { agentId, eventId: eventId ?? `${agentId}-evt-${seq}`, seq, payload: makePayload(seq) };
}

test('乱序到达：提前到达的后续事件保留但不越过缺口展示', () => {
  const dir = tmpDir('sentinel-agg-');
  try {
    const agg = new AggregatorStore(path.join(dir, 'agg.db'));
    const acks1 = agg.applyEvents([env('a', 3), env('a', 4)]);
    assert.deepEqual(acks1, [{ agentId: 'a', watermark: 0 }]);
    assert.equal(agg.watermark('a'), 0);
    assert.deepEqual(agg.records('a'), [], '缺口未补齐前不能展示任何记录');

    const acks2 = agg.applyEvents([env('a', 2)]);
    assert.deepEqual(acks2, [{ agentId: 'a', watermark: 0 }]);
    assert.deepEqual(agg.records('a'), [], '序号 1 未到，仍不能展示');

    const acks3 = agg.applyEvents([env('a', 1)]);
    assert.deepEqual(acks3, [{ agentId: 'a', watermark: 4 }]);
    const records = agg.records('a');
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4]);
    for (const r of records) {
      assert.ok(r.payload.equals(makePayload(r.seq)));
    }
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('重复送达不增加记录数量，水位不回退', () => {
  const dir = tmpDir('sentinel-agg-');
  try {
    const agg = new AggregatorStore(path.join(dir, 'agg.db'));
    agg.applyEvents([env('a', 1), env('a', 2)]);
    assert.equal(agg.watermark('a'), 2);

    // 回执丢失后代理重传相同事件
    const acks = agg.applyEvents([env('a', 1), env('a', 2)]);
    assert.equal(agg.records('a').length, 2, '重复送达不能产生重复记录');
    assert.deepEqual(acks, [{ agentId: 'a', watermark: 2 }]);
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('水位与已公开记录在重启后保持，不回退', () => {
  const dir = tmpDir('sentinel-agg-');
  try {
    const dbPath = path.join(dir, 'agg.db');
    let agg = new AggregatorStore(dbPath);
    agg.applyEvents([env('a', 1), env('a', 2), env('a', 4)]);
    assert.equal(agg.watermark('a'), 2);
    agg.close();

    agg = new AggregatorStore(dbPath);
    assert.equal(agg.watermark('a'), 2, '重启后水位保持');
    assert.deepEqual(agg.records('a').map((r) => r.seq), [1, 2]);

    // 重启后补缺口，水位继续推进
    const acks = agg.applyEvents([env('a', 3)]);
    assert.deepEqual(acks, [{ agentId: 'a', watermark: 4 }]);
    assert.deepEqual(agg.records('a').map((r) => r.seq), [1, 2, 3, 4]);
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('两个代理交错补传：缺口隔离，确认进度互不影响', () => {
  const dir = tmpDir('sentinel-agg-');
  try {
    const dbPath = path.join(dir, 'agg.db');
    let agg = new AggregatorStore(dbPath);

    // 代理 B 先收到序号 3 和 4
    agg.applyEvents([env('b', 3), env('b', 4)]);
    // 代理 A 正常按序到达 1、2
    agg.applyEvents([env('a', 1), env('a', 2)]);

    assert.equal(agg.watermark('b'), 0, 'B 有缺口，水位为 0');
    assert.deepEqual(agg.records('b'), [], 'B 不能展示越过缺口的记录');
    assert.equal(agg.watermark('a'), 2, 'A 的确认进度不受 B 影响');
    assert.deepEqual(agg.records('a').map((r) => r.seq), [1, 2]);

    // B 后收到 1 和 2，补齐缺口
    agg.applyEvents([env('b', 2), env('b', 1)]);
    assert.equal(agg.watermark('b'), 4);
    agg.close();

    // 重启后完整记录与连续确认水位均保持正确
    agg = new AggregatorStore(dbPath);
    assert.equal(agg.watermark('a'), 2);
    assert.equal(agg.watermark('b'), 4);
    assert.deepEqual(agg.records('a').map((r) => r.seq), [1, 2]);
    assert.deepEqual(agg.records('b').map((r) => r.seq), [1, 2, 3, 4]);
    for (const r of agg.records('b')) {
      assert.ok(r.payload.equals(makePayload(r.seq)), `B 记录 seq=${r.seq} 正文逐字节一致`);
    }
    agg.close();
  } finally {
    rmDir(dir);
  }
});

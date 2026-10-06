import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { AgentStore } from '../src/agent';
import { AggregatorStore } from '../src/aggregator';
import { makePayload, rmDir, tmpDir } from './helpers';

const WORKER = path.join(__dirname, 'crash-worker.js');

/** 运行子进程并在收到 killAfterLines 行进度后发送 SIGKILL，模拟进程突然中断。 */
function killMidway(args: string[], killAfterLines: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      env: { ...process.env, SLOW_MS: '2' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (lines.length === killAfterLines) {
          child.kill('SIGKILL');
        }
      }
    });
    child.on('exit', () => resolve(lines));
    child.on('error', reject);
  });
}

/** 运行子进程直到正常结束。 */
function runToEnd(args: string[]): void {
  const res = spawnSync(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  assert.equal(res.status, 0, `worker 应正常结束: ${args.join(' ')}`);
}

test('本地接收中断后，使用原标识重试不产生重复事件或序号缺口', async () => {
  const dir = tmpDir('sentinel-crash-');
  try {
    const db = path.join(dir, 'agent.db');
    // 接收 500 条事件，中途杀死进程
    const lines = await killMidway(['receive', db, 'agent-1', '1', '500'], 100);
    assert.ok(lines.length < 500, '进程必须在中途被杀死，否则未覆盖崩溃场景');
    // 重启后用原标识完整重试
    runToEnd(['receive', db, 'agent-1', '1', '500']);

    const store = new AgentStore(db, 'agent-1');
    assert.equal(store.lastSeq(), 500, '不能出现重复事件或序号缺口');
    const pending = store.pendingEvents(500);
    assert.equal(pending.length, 500);
    for (let i = 0; i < pending.length; i++) {
      assert.equal(pending[i].seq, i + 1, '序号必须从 1 开始连续');
      assert.equal(pending[i].eventId, `evt-${i + 1}`);
      assert.ok(pending[i].payload.equals(makePayload(i + 1)), `seq=${i + 1} 正文逐字节一致`);
    }
    const retry = store.receiveEvent('evt-7', makePayload(7));
    assert.deepEqual(retry, { eventId: 'evt-7', seq: 7, isNew: false });
    store.close();
  } finally {
    rmDir(dir);
  }
});

test('汇总侧已保存但回执丢失（进程中断）：重传去重，重启后记录完整', async () => {
  const dir = tmpDir('sentinel-crash-');
  try {
    const db = path.join(dir, 'agg.db');
    // 汇总侧应用事件途中被杀：已提交的事务保留，回执视为丢失
    const lines = await killMidway(['aggapply', db, 'agent-1', '1', '300'], 80);
    assert.ok(lines.length < 300, '进程必须在中途被杀死，否则未覆盖崩溃场景');
    // 重启后代理重传全部事件（含汇总侧已保存的）
    runToEnd(['aggapply', db, 'agent-1', '1', '300']);

    const agg = new AggregatorStore(db);
    assert.equal(agg.watermark('agent-1'), 300);
    const records = agg.records('agent-1');
    assert.equal(records.length, 300, '重复送达不能增加记录数量');
    for (let i = 0; i < records.length; i++) {
      assert.equal(records[i].seq, i + 1);
      assert.ok(records[i].payload.equals(makePayload(i + 1)), `seq=${i + 1} 正文逐字节一致`);
    }
    // 再次重复送达仍不增加记录
    agg.applyEvents([{ agentId: 'agent-1', eventId: 'evt-1', seq: 1, payload: makePayload(1) }]);
    assert.equal(agg.records('agent-1').length, 300);
    agg.close();
  } finally {
    rmDir(dir);
  }
});

test('代理收到确认后清理过程中断：状态保持一致，重放回执不倒退', async () => {
  const dir = tmpDir('sentinel-crash-');
  try {
    const agentDb = path.join(dir, 'agent.db');
    const aggDb = path.join(dir, 'agg.db');

    // 准备：代理接收 100 条并全部送达汇总侧（回执尚未应用到代理）
    const setup = new AgentStore(agentDb, 'agent-1');
    for (let i = 1; i <= 100; i++) {
      setup.receiveEvent(`evt-${i}`, makePayload(i));
    }
    const agg = new AggregatorStore(aggDb);
    const acks = agg.applyEvents(setup.pendingEvents());
    assert.deepEqual(acks, [{ agentId: 'agent-1', watermark: 100 }]);
    setup.close();
    agg.close();

    // 代理逐条应用回执并清理正文，清理途中被杀
    const lines = await killMidway(['ackloop', agentDb, 'agent-1', '1', '100'], 40);
    assert.ok(lines.length < 100, '进程必须在中途被杀死，否则未覆盖崩溃场景');

    // 中断后状态必须一致：水位 W 与正文清理是原子的
    const check = new AgentStore(agentDb, 'agent-1');
    const w = check.ackWatermark();
    const pending = check.pendingEvents(200);
    assert.equal(pending.length, 100 - w, '水位以内的正文必须已清理、以外的必须保留');
    for (const e of pending) {
      assert.ok(e.seq > w, '不能误删未确认的正文，也不能留下水位以内的正文');
    }
    check.close();

    // 重启后重放全部回执（含延迟到达的旧回执），进度不倒退
    runToEnd(['ackloop', agentDb, 'agent-1', '1', '100']);

    const store = new AgentStore(agentDb, 'agent-1');
    assert.equal(store.ackWatermark(), 100);
    assert.equal(store.pendingEvents().length, 0);
    assert.equal(store.lastSeq(), 100, '不能因重试产生新序号');
    // 已清理事件再次提交仍识别为旧事件
    const again = store.receiveEvent('evt-3', makePayload(3));
    assert.deepEqual(again, { eventId: 'evt-3', seq: 3, isNew: false });
    assert.equal(store.pendingEvents().length, 0, '已清理事件不能重新补传');
    store.close();

    // 汇总侧记录不受代理侧清理中断影响
    const agg2 = new AggregatorStore(aggDb);
    assert.equal(agg2.watermark('agent-1'), 100);
    assert.equal(agg2.records('agent-1').length, 100);
    agg2.close();
  } finally {
    rmDir(dir);
  }
});

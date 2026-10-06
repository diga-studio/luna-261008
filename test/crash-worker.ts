/**
 * 崩溃测试子进程：执行可被 SIGKILL 随时打断的操作，每完成一步同步打印进度。
 * 用法：
 *   node crash-worker.js receive <dbPath> <agentId> <start> <count>
 *   node crash-worker.js aggapply <dbPath> <agentId> <start> <count>
 *   node crash-worker.js ackloop <dbPath> <agentId> <from> <to>
 * 环境变量 SLOW_MS：每步后阻塞休眠的毫秒数，便于父进程在中途杀死。
 */
import * as fs from 'node:fs';
import { AgentStore } from '../src/agent';
import { AggregatorStore } from '../src/aggregator';
import { makePayload } from './helpers';

function sleep(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

const slowMs = Number(process.env.SLOW_MS ?? '0');
const [mode, dbPath, agentId, a, b] = process.argv.slice(2);

if (mode === 'receive') {
  const start = Number(a);
  const count = Number(b);
  const store = new AgentStore(dbPath, agentId);
  for (let i = start; i < start + count; i++) {
    store.receiveEvent(`evt-${i}`, makePayload(i));
    fs.writeSync(1, `RECEIVED ${i}\n`);
    sleep(slowMs);
  }
  store.close();
} else if (mode === 'aggapply') {
  const start = Number(a);
  const count = Number(b);
  const agg = new AggregatorStore(dbPath);
  for (let i = start; i < start + count; i++) {
    agg.applyEvents([{ agentId, eventId: `evt-${i}`, seq: i, payload: makePayload(i) }]);
    fs.writeSync(1, `APPLIED ${i}\n`);
    sleep(slowMs);
  }
  agg.close();
} else if (mode === 'ackloop') {
  const from = Number(a);
  const to = Number(b);
  const store = new AgentStore(dbPath, agentId);
  for (let w = from; w <= to; w++) {
    store.applyAck({ agentId, watermark: w });
    fs.writeSync(1, `ACKED ${w}\n`);
    sleep(slowMs);
  }
  store.close();
} else {
  fs.writeSync(2, `unknown mode: ${mode}\n`);
  process.exit(2);
}

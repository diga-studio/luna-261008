import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentStore } from '../src/agent';
import { AggregatorStore } from '../src/aggregator';
import { AckMessage, EventEnvelope } from '../src/types';

/** 创建临时目录，返回路径。 */
export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 递归删除目录。 */
export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 生成确定性的正文：长度 size，内容完全由 seed 决定。 */
export function makePayload(seed: number, size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed * 31 + i * 7) & 0xff;
  }
  return buf;
}

/** 确定性洗牌（Fisher-Yates，固定种子），用于模拟乱序送达。 */
export function shuffled<T>(items: T[], seed: number): T[] {
  const arr = items.slice();
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 0x100000000;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface SyncOptions {
  /** 每批最多补传多少条（模拟一次只送达部分事件）。 */
  batchSize?: number;
  /** 是否乱序送达。 */
  shuffle?: boolean;
  /** 是否丢弃回执（模拟回执丢失）。 */
  dropAcks?: boolean;
}

/**
 * 执行一轮补传：代理取出待补传事件 -> 汇总侧应用 -> 回执送回代理。
 * 返回本轮汇总侧产生的回执。
 */
export function syncOnce(agent: AgentStore, aggregator: AggregatorStore, opts: SyncOptions = {}): AckMessage[] {
  let batch: EventEnvelope[] = agent.pendingEvents(opts.batchSize);
  if (opts.shuffle) {
    batch = shuffled(batch, 42);
  }
  if (batch.length === 0) {
    return [];
  }
  const acks = aggregator.applyEvents(batch);
  if (!opts.dropAcks) {
    for (const ack of acks) {
      agent.applyAck(ack);
    }
  }
  return acks;
}

/** 持续补传直到代理侧没有待补传事件（模拟连接恢复后持续尝试）。 */
export function syncUntilSettled(agent: AgentStore, aggregator: AggregatorStore, opts: SyncOptions = {}): void {
  for (let i = 0; i < 1000; i++) {
    if (agent.pendingEvents().length === 0) {
      return;
    }
    syncOnce(agent, aggregator, opts);
  }
  throw new Error('sync did not settle');
}

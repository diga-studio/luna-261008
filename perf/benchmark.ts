import { performance } from 'node:perf_hooks';
import { LeadPulse, DAY_MS, EVENT_TYPES } from '../src/index';
import type { BehaviorEvent, EventType } from '../src/index';

/** 规模参数 */
const LEAD_COUNT = 200;
const INITIAL_EVENTS = 500_000;
const HOT_LEAD_EVENTS = 300_000;
const EXTRA_WRITES = 10_000;
const QUERY_COUNT = 20_000;
const WEIGHT_CHANGES = 100;
const SPAN_DAYS = 365;

const TIME_BUDGET_MS = 5_000;
const MEMORY_BUDGET_MIB = 256;

const T0 = 1_700_000_000_000;
const SPAN_MS = SPAN_DAYS * DAY_MS;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) {
    g();
    g();
  }
}

function heapMiB(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function makeEvent(id: string, leadIndex: number, rand: () => number): BehaviorEvent {
  return {
    id,
    leadId: `lead-${leadIndex}`,
    occurredAt: T0 + Math.floor(rand() * SPAN_MS),
    type: EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)] as EventType,
  };
}

function shuffle<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
}

/** 装载初始数据；输入事件在作用域内生成、乱序、写入后丢弃 */
function loadInitial(engine: LeadPulse, rand: () => number): number {
  const events: BehaviorEvent[] = new Array<BehaviorEvent>(INITIAL_EVENTS);
  for (let i = 0; i < HOT_LEAD_EVENTS; i += 1) {
    events[i] = makeEvent(`init-${i}`, 0, rand);
  }
  for (let i = HOT_LEAD_EVENTS; i < INITIAL_EVENTS; i += 1) {
    events[i] = makeEvent(`init-${i}`, 1 + Math.floor(rand() * (LEAD_COUNT - 1)), rand);
  }
  shuffle(events, rand);

  const start = performance.now();
  for (let i = 0; i < LEAD_COUNT; i += 1) {
    engine.registerLead(`lead-${i}`, 1 + Math.floor(rand() * 5000));
  }
  for (const ev of events) {
    engine.recordEvent(ev);
  }
  return performance.now() - start;
}

/** 交错负载：1 万写 / 2 万查 / 100 次调权；输入在作用域内生成并丢弃 */
function runMixed(engine: LeadPulse, rand: () => number): number {
  const extraEvents: BehaviorEvent[] = new Array<BehaviorEvent>(EXTRA_WRITES);
  for (let i = 0; i < EXTRA_WRITES; i += 1) {
    const leadIndex = i % 3 === 0 ? 0 : 1 + Math.floor(rand() * (LEAD_COUNT - 1));
    extraEvents[i] = makeEvent(`extra-${i}`, leadIndex, rand);
  }
  const queries: Array<{ leadIndex: number; at: number }> = [];
  for (let i = 0; i < QUERY_COUNT; i += 1) {
    queries.push({
      leadIndex: Math.floor(rand() * LEAD_COUNT),
      at: T0 + Math.floor(rand() * (SPAN_MS + 30 * DAY_MS)),
    });
  }
  const ops: Array<() => void> = [];
  let wi = 0;
  let qi = 0;
  let ci = 0;
  const total = EXTRA_WRITES + QUERY_COUNT + WEIGHT_CHANGES;
  for (let k = 0; k < total; k += 1) {
    const wLeft = EXTRA_WRITES - wi;
    const qLeft = QUERY_COUNT - qi;
    const cLeft = WEIGHT_CHANGES - ci;
    const pick = rand() * (wLeft + qLeft + cLeft);
    if (pick < wLeft) {
      const ev = extraEvents[wi] as BehaviorEvent;
      ops.push(() => engine.recordEvent(ev));
      wi += 1;
    } else if (pick < wLeft + qLeft) {
      const q = queries[qi] as { leadIndex: number; at: number };
      ops.push(() => engine.getScore(`lead-${q.leadIndex}`, q.at));
      qi += 1;
    } else {
      const type = EVENT_TYPES[ci % EVENT_TYPES.length] as EventType;
      const weight = Math.floor(rand() * 101);
      ops.push(() => engine.setWeight(type, weight));
      ci += 1;
    }
  }

  const start = performance.now();
  for (const op of ops) {
    op();
  }
  return performance.now() - start;
}

function main(): void {
  const rand = mulberry32(20261008);
  const engine = new LeadPulse();

  gc();
  const heapBase = heapMiB();

  const loadMs = loadInitial(engine, rand);
  gc();
  const heapAfterLoad = heapMiB();

  const mixMs = runMixed(engine, rand);
  gc();
  const heapAfterMix = heapMiB();

  const loadMem = heapAfterLoad - heapBase;
  const totalMem = heapAfterMix - heapBase;
  const totalOps = EXTRA_WRITES + QUERY_COUNT + WEIGHT_CHANGES;
  process.stdout.write(
    `规模: ${LEAD_COUNT} 线索, ${INITIAL_EVENTS} 初始事件 (热点线索 ${HOT_LEAD_EVENTS}), 跨度 ${SPAN_DAYS} 天\n`,
  );
  process.stdout.write(
    `装载: ${loadMs.toFixed(1)} ms (${(INITIAL_EVENTS / (loadMs / 1000)).toFixed(0)} events/s)\n`,
  );
  process.stdout.write(
    `交错负载: ${totalOps} 次操作 (${EXTRA_WRITES} 写 / ${QUERY_COUNT} 查 / ${WEIGHT_CHANGES} 调权) 耗时 ${mixMs.toFixed(1)} ms\n`,
  );
  process.stdout.write(
    `组件堆内存: 装载后 +${loadMem.toFixed(1)} MiB, 负载后 +${totalMem.toFixed(1)} MiB\n`,
  );

  const timeOk = mixMs <= TIME_BUDGET_MS;
  const memOk = totalMem <= MEMORY_BUDGET_MIB;
  process.stdout.write(`耗时预算 ${TIME_BUDGET_MS} ms: ${timeOk ? 'PASS' : 'FAIL'}\n`);
  process.stdout.write(`内存预算 ${MEMORY_BUDGET_MIB} MiB: ${memOk ? 'PASS' : 'FAIL'}\n`);
  if (!timeOk || !memOk) {
    process.exit(1);
  }
}

main();

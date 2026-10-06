import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MachineConfig, SchedulingEngine } from '../src/index.js';

const MACHINE_COUNT = 16;
const INITIAL_JOBS = 100_000;
const CHANGE_COUNT = 50_000;
const QUERY_COUNT = 50_000;
const TIME_LIMIT_MS = 10_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const BUSY_MACHINE = 'M0';

const grades = ['normal', 'lamination', 'diecut'] as const;

/** 确定性 xorshift32。 */
function makeRng(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) gc();
}

test('性能：5 万次变更 + 5 万次查询（80% 集中于一台印机）', { timeout: 120_000 }, () => {
  const rand = makeRng(0xc0ffee);
  const machines: MachineConfig[] = Array.from({ length: MACHINE_COUNT }, (_, i) => ({
    id: `M${i}`,
    sheetsPerHour: 2_000 + i * 500,
    availableFrom: i * 60,
  }));
  const engine = new SchedulingEngine(machines);

  // 测试侧镜像，用于跟踪哪些作业位于繁忙印机的队尾（优先级 5）。
  const meta = new Map<string, { machineId: string; priority: number }>();
  const live: string[] = [];
  const tailSet = new Set<string>();
  const tailList: string[] = [];
  const trackTail = (id: string): void => {
    const info = meta.get(id);
    const isTail = info !== undefined && info.machineId === BUSY_MACHINE && info.priority === 5;
    if (isTail && !tailSet.has(id)) {
      tailSet.add(id);
      tailList.push(id);
    } else if (!isTail && tailSet.has(id)) {
      tailSet.delete(id); // tailList 中条目惰性清理
    }
  };
  const pickTail = (): string | undefined => {
    while (tailList.length > 0) {
      const index = rand(tailList.length);
      const id = tailList[index];
      if (tailSet.has(id)) return id;
      tailList[index] = tailList[tailList.length - 1];
      tailList.pop();
    }
    return undefined;
  };

  let nextId = 0;
  const addOne = (busyBias: number, headBias: boolean): void => {
    const id = `J${nextId}`;
    nextId += 1;
    const busy = rand(10) < busyBias;
    const machineId = busy ? BUSY_MACHINE : `M${1 + rand(MACHINE_COUNT - 1)}`;
    const priority = headBias && rand(2) === 0 ? 1 : 1 + rand(5);
    engine.addJob(id, machineId, priority, 1 + rand(100_000), grades[rand(3)]);
    meta.set(id, { machineId, priority });
    live.push(id);
    trackTail(id);
  };

  // 初始化：80% 作业集中在 M0，其余分散到另外 15 台。
  for (let i = 0; i < INITIAL_JOBS; i += 1) addOne(8, false);

  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  let changes = 0;
  let queries = 0;
  while (changes < CHANGE_COUNT || queries < QUERY_COUNT) {
    if (changes < CHANGE_COUNT) {
      // 变更：加入 / 修改（含优先级调整与跨机改派）/ 撤出，偏向影响 M0 队首。
      const kind = rand(10);
      if (kind < 3 && live.length < INITIAL_JOBS) {
        addOne(8, true);
      } else if (kind < 8) {
        const id = live[rand(live.length)];
        const info = meta.get(id) as { machineId: string; priority: number };
        const sub = rand(4);
        if (sub === 0) {
          const machineId = `M${rand(MACHINE_COUNT)}`;
          engine.updateJob(id, { machineId });
          info.machineId = machineId;
        } else if (sub === 1) {
          // 优先级调整，偏向调到最高级以搅动队首。
          const priority = rand(2) === 0 ? 1 : 1 + rand(5);
          engine.updateJob(id, { priority });
          info.priority = priority;
        } else if (sub === 2) {
          engine.updateJob(id, { sheets: 1 + rand(100_000) });
        } else {
          engine.updateJob(id, { grade: grades[rand(3)] });
        }
        trackTail(id);
      } else {
        const index = rand(live.length);
        const id = live[index];
        live.splice(index, 1);
        engine.removeJob(id);
        meta.delete(id);
        trackTail(id);
      }
      changes += 1;
    }
    if (queries < QUERY_COUNT) {
      // 查询集中在 M0 队尾（优先级 5 的作业）。
      const tail = rand(10) < 8 ? pickTail() : undefined;
      const id = tail ?? live[rand(live.length)];
      const result = engine.queryJob(id);
      assert.ok(result.completeAt >= result.startAt);
      queries += 1;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  forceGc();
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;

  console.log(
    `  [perf] ${CHANGE_COUNT} 次变更 + ${QUERY_COUNT} 次查询耗时 ${elapsedMs.toFixed(0)} ms，` +
      `堆增量 ${(heapDelta / 1024 / 1024).toFixed(1)} MiB，剩余作业 ${engine.size}`,
  );
  assert.ok(
    elapsedMs < TIME_LIMIT_MS,
    `耗时 ${elapsedMs.toFixed(0)} ms 超过 ${TIME_LIMIT_MS} ms`,
  );
  assert.ok(
    heapDelta < MEMORY_LIMIT_BYTES,
    `堆增量 ${(heapDelta / 1024 / 1024).toFixed(1)} MiB 超过 256 MiB`,
  );
});

import { describe, it } from 'node:test';
import { ok } from 'node:assert/strict';
import { Scheduler } from '../src/scheduler';
import { Grade, MachineSpec } from '../src/types';

const GRADES: Grade[] = ['normal', 'lamination', 'diecut'];
const MACHINE_COUNT = 16;
const JOB_COUNT = 100_000;
const CHANGE_COUNT = 50_000;
const QUERY_COUNT = 50_000;
const TIME_BUDGET_MS = 10_000;
const MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeMachines(): MachineSpec[] {
  const machines: MachineSpec[] = [];
  for (let i = 0; i < MACHINE_COUNT; i += 1) {
    machines.push({
      id: `M${i}`,
      sheetsPerHour: 3000 + i * 500,
      availableAt: 1_700_000_000 + i * 60,
    });
  }
  return machines;
}

/** 可交换删除的存活作业集合，支持 O(1) 随机取 */
class LivePool {
  private ids: string[] = [];
  private index = new Map<string, number>();

  add(id: string): void {
    this.index.set(id, this.ids.length);
    this.ids.push(id);
  }

  remove(id: string): void {
    const at = this.index.get(id);
    if (at === undefined) return;
    const last = this.ids.pop() as string;
    if (last !== id) {
      this.ids[at] = last;
      this.index.set(last, at);
    }
    this.index.delete(id);
  }

  random(rand: () => number): string {
    return this.ids[Math.floor(rand() * this.ids.length)] as string;
  }

  get size(): number {
    return this.ids.length;
  }
}

describe('性能与内存', () => {
  it('16 台印机 / 10 万作业：5 万次变更 + 5 万次查询 < 10s，内存 < 256MiB', () => {
    const rand = mulberry32(20240601);
    const scheduler = new Scheduler(makeMachines());
    const pool = new LivePool();
    let nextJob = 0;

    // 初始化（不计时）
    for (let i = 0; i < JOB_COUNT; i += 1) {
      const id = `J${nextJob}`;
      nextJob += 1;
      scheduler.addJob({
        id,
        machineId: `M${Math.floor(rand() * MACHINE_COUNT)}`,
        priority: 1 + Math.floor(rand() * 5),
        sheets: 1 + Math.floor(rand() * 100_000),
        grade: GRADES[Math.floor(rand() * GRADES.length)]!,
      });
      pool.add(id);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();

    for (let i = 0; i < CHANGE_COUNT; i += 1) {
      const roll = rand();
      if (roll < 0.34) {
        // 撤出 + 补充一个，保持约 10 万等待作业
        const victim = pool.random(rand);
        scheduler.removeJob(victim);
        pool.remove(victim);
        const id = `J${nextJob}`;
        nextJob += 1;
        scheduler.addJob({
          id,
          machineId: `M${Math.floor(rand() * MACHINE_COUNT)}`,
          priority: 1 + Math.floor(rand() * 5),
          sheets: 1 + Math.floor(rand() * 100_000),
          grade: GRADES[Math.floor(rand() * GRADES.length)]!,
        });
        pool.add(id);
      } else if (roll < 0.67) {
        // 优先级调整
        scheduler.updateJob(pool.random(rand), {
          priority: 1 + Math.floor(rand() * 5),
        });
      } else {
        // 跨印机改派 + 加工量调整
        scheduler.updateJob(pool.random(rand), {
          machineId: `M${Math.floor(rand() * MACHINE_COUNT)}`,
          sheets: 1 + Math.floor(rand() * 100_000),
          grade: GRADES[Math.floor(rand() * GRADES.length)]!,
        });
      }
      // 每次变更后交替查询一个作业，总计 5 万次查询
      if (i < QUERY_COUNT) {
        const status = scheduler.query(pool.random(rand));
        ok(status.finishAt >= status.startAt);
      }
    }

    const elapsedMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    console.log(
      `  [perf] 均匀分布: ${elapsedMs.toFixed(0)}ms, ` +
        `堆内存增量 ${((heapAfter - heapBefore) / 1048576).toFixed(1)} MiB`,
    );
    ok(elapsedMs < TIME_BUDGET_MS, `耗时 ${elapsedMs}ms 超过 ${TIME_BUDGET_MS}ms`);
    ok(
      heapAfter - heapBefore < MEMORY_BUDGET_BYTES,
      `内存增量 ${heapAfter - heapBefore} 超过预算`,
    );
  });

  it('80% 作业集中一台印机：变更频繁影响队首、查询集中队尾', () => {
    const rand = mulberry32(99);
    const scheduler = new Scheduler(makeMachines());
    const pool = new LivePool();
    const hotMachine = 'M0';
    const headRegion: string[] = [];
    const tailRegion: string[] = [];
    let nextJob = 0;

    const addJob = (machineId: string): string => {
      const id = `J${nextJob}`;
      nextJob += 1;
      scheduler.addJob({
        id,
        machineId,
        priority: 1 + Math.floor(rand() * 5),
        sheets: 1 + Math.floor(rand() * 100_000),
        grade: GRADES[Math.floor(rand() * GRADES.length)]!,
      });
      pool.add(id);
      return id;
    };

    // 初始化：80% 集中在 M0（不计时）
    for (let i = 0; i < JOB_COUNT; i += 1) {
      const machineId = rand() < 0.8 ? hotMachine : `M${1 + Math.floor(rand() * (MACHINE_COUNT - 1))}`;
      const id = addJob(machineId);
      if (machineId === hotMachine) {
        if (i < 2000) headRegion.push(id);
        tailRegion.push(id);
        if (tailRegion.length > 2000) tailRegion.shift();
      }
    }

    const started = performance.now();

    for (let i = 0; i < CHANGE_COUNT; i += 1) {
      const roll = rand();
      if (roll < 0.5 && headRegion.length > 0) {
        // 变更集中在队首区域：调优先级 / 改加工量 / 撤出后重新加入
        const id = headRegion[Math.floor(rand() * headRegion.length)]!;
        if (rand() < 0.3) {
          scheduler.removeJob(id);
          pool.remove(id);
          headRegion.splice(headRegion.indexOf(id), 1);
          const fresh = addJob(hotMachine);
          headRegion.push(fresh);
        } else {
          scheduler.updateJob(id, {
            priority: 1 + Math.floor(rand() * 5),
            sheets: 1 + Math.floor(rand() * 100_000),
          });
        }
      } else if (roll < 0.75) {
        // 跨印机改派：在 M0 与其他印机之间来回
        const id = pool.random(rand);
        scheduler.updateJob(id, {
          machineId: rand() < 0.5 ? hotMachine : `M${1 + Math.floor(rand() * (MACHINE_COUNT - 1))}`,
        });
      } else {
        scheduler.updateJob(pool.random(rand), {
          priority: 1 + Math.floor(rand() * 5),
        });
      }
      // 查询集中在队尾
      if (i < QUERY_COUNT) {
        const target = rand() < 0.9 && tailRegion.length > 0
          ? tailRegion[Math.floor(rand() * tailRegion.length)]!
          : pool.random(rand);
        try {
          scheduler.query(target);
        } catch {
          // 队尾样本可能已被撤出，改查任意存活作业
          scheduler.query(pool.random(rand));
        }
      }
    }

    const elapsedMs = performance.now() - started;
    console.log(`  [perf] 集中分布: ${elapsedMs.toFixed(0)}ms`);
    ok(elapsedMs < TIME_BUDGET_MS, `耗时 ${elapsedMs}ms 超过 ${TIME_BUDGET_MS}ms`);
  });
});

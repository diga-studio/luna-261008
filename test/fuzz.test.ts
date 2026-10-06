import { describe, it } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { Scheduler } from '../src/scheduler';
import { Grade, MachineSpec } from '../src/types';
import { ReferenceScheduler } from './reference';

const GRADES: Grade[] = ['normal', 'lamination', 'diecut'];

/** 可复现的伪随机数发生器 */
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

function runFuzz(seed: number, rounds: number): void {
  const rand = mulberry32(seed);
  const machines: MachineSpec[] = [
    { id: 'M0', sheetsPerHour: 3600, availableAt: 500 },
    { id: 'M1', sheetsPerHour: 7200, availableAt: 0 },
    { id: 'M2', sheetsPerHour: 1000, availableAt: 9999 },
    { id: 'M3', sheetsPerHour: 5000, availableAt: 123456 },
  ];
  const scheduler = new Scheduler(machines);
  const reference = new ReferenceScheduler(machines);
  const live = new Set<string>();
  let nextJob = 0;

  const pickMachine = () => machines[Math.floor(rand() * machines.length)]!.id;
  const pickLiveJob = (): string | undefined => {
    if (live.size === 0) return undefined;
    const ids = Array.from(live);
    return ids[Math.floor(rand() * ids.length)];
  };

  for (let round = 0; round < rounds; round += 1) {
    const roll = rand();
    if (roll < 0.4 || live.size === 0) {
      const id = `J${nextJob}`;
      nextJob += 1;
      const input = {
        id,
        machineId: pickMachine(),
        priority: 1 + Math.floor(rand() * 5),
        sheets: 1 + Math.floor(rand() * 5000),
        grade: GRADES[Math.floor(rand() * GRADES.length)]!,
      };
      scheduler.addJob(input);
      reference.addJob(input);
      live.add(id);
    } else if (roll < 0.75) {
      const id = pickLiveJob()!;
      const patch: Record<string, unknown> = {};
      if (rand() < 0.35) patch.machineId = pickMachine();
      if (rand() < 0.5) patch.priority = 1 + Math.floor(rand() * 5);
      if (rand() < 0.4) patch.sheets = 1 + Math.floor(rand() * 5000);
      if (rand() < 0.3) patch.grade = GRADES[Math.floor(rand() * GRADES.length)]!;
      scheduler.updateJob(id, patch);
      reference.updateJob(id, patch);
    } else {
      const id = pickLiveJob()!;
      scheduler.removeJob(id);
      reference.removeJob(id);
      live.delete(id);
    }
  }

  // 全量比对：每个存活作业的排队位置与起止时刻都必须与参照一致
  for (const id of live) {
    deepEqual(scheduler.query(id), reference.query(id), `job ${id} seed ${seed}`);
  }
  equal(scheduler.size, live.size);
}

describe('随机对照', () => {
  it('种子 1：2000 轮混合操作后与参照一致', () => runFuzz(1, 2000));
  it('种子 42：5000 轮混合操作后与参照一致', () => runFuzz(42, 5000));
  it('种子 777：3000 轮混合操作后与参照一致', () => runFuzz(777, 3000));
});

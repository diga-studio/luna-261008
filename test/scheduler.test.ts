import { describe, it } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';
import { Scheduler } from '../src/scheduler';
import { MachineSpec } from '../src/types';
import { ReferenceScheduler } from './reference';

const MACHINES: MachineSpec[] = [
  { id: 'P1', sheetsPerHour: 3600, availableAt: 1000 },
  { id: 'P2', sheetsPerHour: 7200, availableAt: 2000 },
];

describe('急单插入后撤出', () => {
  it('原作业先推迟再恢复，最早空闲时刻不变', () => {
    const scheduler = new Scheduler(MACHINES);
    const reference = new ReferenceScheduler(MACHINES);
    scheduler.addJob({ id: 'A', machineId: 'P1', priority: 3, sheets: 3600, grade: 'normal' });
    scheduler.addJob({ id: 'B', machineId: 'P1', priority: 3, sheets: 1800, grade: 'diecut' });
    reference.addJob({ id: 'A', machineId: 'P1', priority: 3, sheets: 3600, grade: 'normal' });
    reference.addJob({ id: 'B', machineId: 'P1', priority: 3, sheets: 1800, grade: 'diecut' });

    // A 耗时 3600s，B 耗时 3600s
    deepEqual(scheduler.query('A'), { id: 'A', machineId: 'P1', position: 1, startAt: 1000, finishAt: 4600 });
    deepEqual(scheduler.query('B'), { id: 'B', machineId: 'P1', position: 2, startAt: 4600, finishAt: 8200 });

    // 插入急单（优先级 1，覆膜 2400 张 -> 2400*1.5=3600 张当量 -> 3600s）
    scheduler.addJob({ id: 'URGENT', machineId: 'P1', priority: 1, sheets: 2400, grade: 'lamination' });
    reference.addJob({ id: 'URGENT', machineId: 'P1', priority: 1, sheets: 2400, grade: 'lamination' });
    deepEqual(scheduler.query('URGENT'), { id: 'URGENT', machineId: 'P1', position: 1, startAt: 1000, finishAt: 4600 });
    deepEqual(scheduler.query('A'), { id: 'A', machineId: 'P1', position: 2, startAt: 4600, finishAt: 8200 });
    deepEqual(scheduler.query('B'), { id: 'B', machineId: 'P1', position: 3, startAt: 8200, finishAt: 11800 });

    // 撤出急单后恢复原状，最早空闲时刻始终是 1000
    scheduler.removeJob('URGENT');
    reference.removeJob('URGENT');
    deepEqual(scheduler.query('A'), reference.query('A'));
    deepEqual(scheduler.query('B'), reference.query('B'));
    equal(scheduler.query('A').startAt, 1000);
    equal(scheduler.query('B').startAt, 4600);
  });
});

describe('优先级调整与同级先后', () => {
  it('较早入队的作业提升优先级后排在同级较晚入队作业之前', () => {
    const scheduler = new Scheduler(MACHINES);
    scheduler.addJob({ id: 'A', machineId: 'P1', priority: 4, sheets: 3600, grade: 'normal' });
    scheduler.addJob({ id: 'B', machineId: 'P1', priority: 2, sheets: 3600, grade: 'normal' });
    scheduler.addJob({ id: 'C', machineId: 'P1', priority: 2, sheets: 3600, grade: 'normal' });
    // 初始顺序：B, C, A
    equal(scheduler.query('B').position, 1);
    equal(scheduler.query('C').position, 2);
    equal(scheduler.query('A').position, 3);

    // A 提升到 2 级：A 入队早于 B、C，应排在同级最前
    scheduler.updateJob('A', { priority: 2 });
    equal(scheduler.query('A').position, 1);
    equal(scheduler.query('B').position, 2);
    equal(scheduler.query('C').position, 3);

    // 反复调整不改入队先后：A 降回 4 再升回 2，仍在 B、C 前
    scheduler.updateJob('A', { priority: 4 });
    equal(scheduler.query('A').position, 3);
    scheduler.updateJob('A', { priority: 2 });
    equal(scheduler.query('A').position, 1);
    equal(scheduler.query('B').position, 2);
    equal(scheduler.query('C').position, 3);

    // 修改加工量同样保留入队先后
    scheduler.updateJob('C', { sheets: 7200, priority: 1 });
    equal(scheduler.query('C').position, 1);
    // B 入队序号(2)早于 C(3)，B 升到 1 级后同级按入队先后，B 在前
    scheduler.updateJob('B', { priority: 1 });
    equal(scheduler.query('B').position, 1);
    equal(scheduler.query('C').position, 2);
    equal(scheduler.query('A').position, 3);
  });
});

describe('跨印机改派', () => {
  it('在新印机重新入队，两条队列工期都正确', () => {
    const scheduler = new Scheduler(MACHINES);
    const reference = new ReferenceScheduler(MACHINES);
    const adds = [
      { id: 'A', machineId: 'P1', priority: 2, sheets: 3600, grade: 'normal' as const },
      { id: 'B', machineId: 'P1', priority: 2, sheets: 3600, grade: 'normal' as const },
      { id: 'X', machineId: 'P2', priority: 2, sheets: 7200, grade: 'normal' as const },
      { id: 'Y', machineId: 'P2', priority: 2, sheets: 3600, grade: 'diecut' as const },
    ];
    for (const add of adds) {
      scheduler.addJob(add);
      reference.addJob(add);
    }

    // B 改派到 P2：在 P2 重新入队，排在 X、Y 之后；P1 上 A 之后不再有作业
    scheduler.updateJob('B', { machineId: 'P2' });
    reference.updateJob('B', { machineId: 'P2' });
    for (const id of ['A', 'B', 'X', 'Y']) {
      deepEqual(scheduler.query(id), reference.query(id), `job ${id}`);
    }
    equal(scheduler.query('B').machineId, 'P2');
    equal(scheduler.query('B').position, 3);
    // P2 产能 7200/h：X 3600s，Y 3600s，B 1800s
    equal(scheduler.query('B').startAt, 2000 + 3600 + 3600);
    equal(scheduler.query('B').finishAt, 2000 + 3600 + 3600 + 1800);

    // 新入队的 Z 在 P2 上优先级更高，插到队首；B 的同级序号仍晚于 X、Y
    scheduler.addJob({ id: 'Z', machineId: 'P2', priority: 1, sheets: 7200, grade: 'normal' });
    reference.addJob({ id: 'Z', machineId: 'P2', priority: 1, sheets: 7200, grade: 'normal' });
    scheduler.updateJob('B', { priority: 2, sheets: 14400 });
    reference.updateJob('B', { priority: 2, sheets: 14400 });
    for (const id of ['A', 'B', 'X', 'Y', 'Z']) {
      deepEqual(scheduler.query(id), reference.query(id), `job ${id}`);
    }
    equal(scheduler.query('Z').position, 1);
    equal(scheduler.query('B').position, 4);

    // B 再改派回 P1：再次重新入队，排在 A 之后
    scheduler.updateJob('B', { machineId: 'P1' });
    reference.updateJob('B', { machineId: 'P1' });
    for (const id of ['A', 'B', 'X', 'Y', 'Z']) {
      deepEqual(scheduler.query(id), reference.query(id), `job ${id}`);
    }
    equal(scheduler.query('B').position, 2);
  });
});

describe('逐作业取整', () => {
  it('累计差异与参照一致', () => {
    // 产能 1000/h：每个 1 张普通作业 ceil(3.6s)=4s，3 个作业累计 12s；
    // 若合并取整则为 ceil(10.8)=11s，逐作业取整必须得到 12s
    const machines: MachineSpec[] = [{ id: 'M', sheetsPerHour: 1000, availableAt: 0 }];
    const scheduler = new Scheduler(machines);
    scheduler.addJob({ id: 'J1', machineId: 'M', priority: 1, sheets: 1, grade: 'normal' });
    scheduler.addJob({ id: 'J2', machineId: 'M', priority: 1, sheets: 1, grade: 'normal' });
    scheduler.addJob({ id: 'J3', machineId: 'M', priority: 1, sheets: 1, grade: 'normal' });
    equal(scheduler.query('J1').finishAt, 4);
    equal(scheduler.query('J2').startAt, 4);
    equal(scheduler.query('J2').finishAt, 8);
    equal(scheduler.query('J3').startAt, 8);
    equal(scheduler.query('J3').finishAt, 12);

    // 覆膜 1 张：ceil(5.4)=6s
    scheduler.updateJob('J2', { grade: 'lamination' });
    equal(scheduler.query('J2').finishAt - scheduler.query('J2').startAt, 6);
    equal(scheduler.query('J3').startAt, 10);
  });
});

describe('参数校验', () => {
  it('非法输入抛错', () => {
    const scheduler = new Scheduler(MACHINES);
    throws(() => scheduler.addJob({ id: 'A', machineId: 'NOPE', priority: 1, sheets: 1, grade: 'normal' }));
    throws(() => scheduler.addJob({ id: 'A', machineId: 'P1', priority: 0, sheets: 1, grade: 'normal' }));
    throws(() => scheduler.addJob({ id: 'A', machineId: 'P1', priority: 6, sheets: 1, grade: 'normal' }));
    throws(() => scheduler.addJob({ id: 'A' as string, machineId: 'P1', priority: 1, sheets: 0, grade: 'normal' }));
    throws(() => scheduler.addJob({ id: 'A', machineId: 'P1', priority: 1, sheets: 1_000_001, grade: 'normal' }));
    scheduler.addJob({ id: 'A', machineId: 'P1', priority: 1, sheets: 1, grade: 'normal' });
    throws(() => scheduler.addJob({ id: 'A', machineId: 'P1', priority: 1, sheets: 1, grade: 'normal' }));
    throws(() => scheduler.updateJob('GHOST', { priority: 2 }));
    throws(() => scheduler.removeJob('GHOST'));
    throws(() => scheduler.query('GHOST'));
    throws(() => scheduler.updateJob('A', { machineId: 'NOPE' }));
    throws(() => new Scheduler([{ id: 'M', sheetsPerHour: 0, availableAt: 0 }]));
  });
});

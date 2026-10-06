import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MachineConfig, SchedulingEngine } from '../src/index.js';
import { ReferenceQueue } from './reference.js';

const MACHINES: MachineConfig[] = [
  { id: 'P1', sheetsPerHour: 3600, availableFrom: 1_000 },
  { id: 'P2', sheetsPerHour: 1800, availableFrom: 5_000 },
];

test('繁忙印机插入急单后撤出：原作业先推迟再恢复，最早空闲时刻不变', () => {
  const engine = new SchedulingEngine(MACHINES);
  // P1 产能 3600 张/小时，普通档 1000 张 = 1000 秒。
  engine.addJob('A', 'P1', 3, 1000, 'normal');
  engine.addJob('B', 'P1', 3, 2000, 'normal');
  engine.addJob('C', 'P1', 4, 500, 'normal');

  const before = {
    A: engine.queryJob('A'),
    B: engine.queryJob('B'),
    C: engine.queryJob('C'),
  };
  assert.equal(before.A.startAt, 1000);
  assert.equal(before.B.startAt, 2000);
  assert.equal(before.C.startAt, 4000);

  // 插入急单（优先级 1，覆膜 400 张：400*1.5=600 秒）。
  engine.addJob('RUSH', 'P1', 1, 400, 'lamination');
  const during = {
    RUSH: engine.queryJob('RUSH'),
    A: engine.queryJob('A'),
    B: engine.queryJob('B'),
    C: engine.queryJob('C'),
  };
  assert.equal(during.RUSH.position, 1);
  assert.equal(during.RUSH.startAt, 1000);
  assert.equal(during.RUSH.completeAt, 1600);
  assert.equal(during.A.startAt, 1600);
  assert.equal(during.B.startAt, 2600);
  assert.equal(during.C.startAt, 4600);

  // 撤出急单后全部恢复，且队首仍从最早空闲时刻开始。
  engine.removeJob('RUSH');
  assert.deepEqual(engine.queryJob('A'), before.A);
  assert.deepEqual(engine.queryJob('B'), before.B);
  assert.deepEqual(engine.queryJob('C'), before.C);
  assert.equal(engine.queryJob('A').startAt, 1000);
});

test('优先级反复调整：保留原入队先后', () => {
  const engine = new SchedulingEngine(MACHINES);
  engine.addJob('A', 'P1', 3, 100, 'normal'); // seq 0
  engine.addJob('B', 'P1', 2, 100, 'normal'); // seq 1
  engine.addJob('C', 'P1', 2, 100, 'normal'); // seq 2

  // A 提升到 2 级后保留 seq 0，排在同级较晚入队的 B、C 之前。
  engine.updateJob('A', { priority: 2 });
  assert.equal(engine.queryJob('A').position, 1);
  assert.equal(engine.queryJob('B').position, 2);
  assert.equal(engine.queryJob('C').position, 3);

  // 反复调整：A 降到 5 再升回 2，先后仍按原 seq。
  engine.updateJob('A', { priority: 5 });
  assert.equal(engine.queryJob('B').position, 1);
  assert.equal(engine.queryJob('C').position, 2);
  assert.equal(engine.queryJob('A').position, 3);
  engine.updateJob('A', { priority: 2 });
  assert.equal(engine.queryJob('A').position, 1);
  assert.equal(engine.queryJob('B').position, 2);

  // B 升到 1 级：独占新级别，排在最前；A、C 顺序不变。
  engine.updateJob('B', { priority: 1 });
  assert.equal(engine.queryJob('B').position, 1);
  assert.equal(engine.queryJob('A').position, 2);
  assert.equal(engine.queryJob('C').position, 3);
});

test('修改加工量不改变同级入队先后', () => {
  const engine = new SchedulingEngine(MACHINES);
  engine.addJob('A', 'P1', 2, 100, 'normal'); // seq 0
  engine.addJob('B', 'P1', 2, 100, 'normal'); // seq 1
  engine.updateJob('B', { sheets: 900, grade: 'diecut' });
  assert.equal(engine.queryJob('A').position, 1);
  assert.equal(engine.queryJob('B').position, 2);
  // B 耗时 = 900*2 = 1800 秒（P1 产能 3600/小时）。
  assert.equal(engine.queryJob('B').duration, 1800);
});

test('跨印机改派：在新印机重新入队，两条队列工期都正确', () => {
  const engine = new SchedulingEngine(MACHINES);
  engine.addJob('A', 'P1', 2, 1000, 'normal'); // P1 seq 0
  engine.addJob('B', 'P1', 2, 1000, 'normal'); // P1 seq 1
  engine.addJob('X', 'P2', 2, 900, 'normal'); // P2 seq 0，P2 产能 1800 → 1800 秒

  // B 改派到 P2：在 P2 重新入队（seq 1），排在 X 之后。
  engine.updateJob('B', { machineId: 'P2' });
  assert.equal(engine.queryJob('B').machineId, 'P2');
  assert.equal(engine.queryJob('X').position, 1);
  assert.equal(engine.queryJob('B').position, 2);
  // P2 上 B 的耗时按 P2 产能重算：1000 张 / 1800 张每小时 = 2000 秒。
  assert.equal(engine.queryJob('B').duration, 2000);
  assert.equal(engine.queryJob('X').startAt, 5000);
  assert.equal(engine.queryJob('B').startAt, 5000 + 1800);

  // 旧印机 P1 上 A 之后不再有作业。
  assert.equal(engine.queryJob('A').position, 1);
  assert.equal(engine.queryJob('A').completeAt, 2000);

  // B 再改派回 P1：视为重新入队，排在 A 之后。
  engine.updateJob('B', { machineId: 'P1' });
  assert.equal(engine.queryJob('A').position, 1);
  assert.equal(engine.queryJob('B').position, 2);
  assert.equal(engine.queryJob('B').startAt, 2000);
  // P2 上只剩 X。
  assert.equal(engine.queryJob('X').position, 1);
});

test('单作业取整再累加，与合并取整不同', () => {
  // 产能 1000 张/小时：1 张普通档 = 3.6 秒，向上取整为 4 秒。
  const engine = new SchedulingEngine([
    { id: 'P1', sheetsPerHour: 1000, availableFrom: 0 },
  ]);
  engine.addJob('A', 'P1', 1, 1, 'normal');
  engine.addJob('B', 'P1', 1, 1, 'normal');
  engine.addJob('C', 'P1', 1, 1, 'normal');
  // 若合并 3 张统一取整应为 11 秒；按作业分别取整为 12 秒。
  assert.equal(engine.queryJob('C').startAt, 8);
  assert.equal(engine.queryJob('C').completeAt, 12);
});

test('随机操作序列与独立参照一致', () => {
  const machines: MachineConfig[] = [
    { id: 'M0', sheetsPerHour: 733, availableFrom: 12_345 },
    { id: 'M1', sheetsPerHour: 1_997, availableFrom: 999 },
    { id: 'M2', sheetsPerHour: 15_000, availableFrom: 0 },
  ];
  const engine = new SchedulingEngine(machines);
  const reference = new ReferenceQueue(machines);
  const grades = ['normal', 'lamination', 'diecut'] as const;

  // 确定性伪随机数。
  let state = 0x12345678;
  const rand = (n: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };

  const live: string[] = [];
  let nextId = 0;
  for (let step = 0; step < 4000; step += 1) {
    const op = rand(10);
    if (op < 4 || live.length === 0) {
      const id = `J${nextId}`;
      nextId += 1;
      const machineId = `M${rand(3)}`;
      const priority = 1 + rand(5);
      const sheets = 1 + rand(50_000);
      const grade = grades[rand(3)];
      engine.addJob(id, machineId, priority, sheets, grade);
      reference.addJob(id, machineId, priority, sheets, grade);
      live.push(id);
    } else if (op < 7) {
      const id = live[rand(live.length)];
      const changes: Record<string, unknown> = {};
      const kind = rand(4);
      if (kind === 0) changes.machineId = `M${rand(3)}`;
      else if (kind === 1) changes.priority = 1 + rand(5);
      else if (kind === 2) changes.sheets = 1 + rand(50_000);
      else changes.grade = grades[rand(3)];
      engine.updateJob(id, changes);
      reference.updateJob(id, changes);
    } else if (op < 8) {
      const index = rand(live.length);
      const id = live[index];
      live.splice(index, 1);
      engine.removeJob(id);
      reference.removeJob(id);
    } else {
      const id = live[rand(live.length)];
      assert.deepEqual(engine.queryJob(id), reference.queryJob(id), `job ${id}`);
    }
  }
  // 收尾：全部查询逐一比对。
  for (const id of live) {
    assert.deepEqual(engine.queryJob(id), reference.queryJob(id), `job ${id}`);
  }
});

test('参数校验', () => {
  assert.throws(() => new SchedulingEngine([]), /至少需要一台印机/);
  assert.throws(
    () =>
      new SchedulingEngine(
        Array.from({ length: 17 }, (_, i) => ({
          id: `M${i}`,
          sheetsPerHour: 1000,
          availableFrom: 0,
        })),
      ),
    /不能超过 16/,
  );
  assert.throws(
    () =>
      new SchedulingEngine([
        { id: 'M', sheetsPerHour: 1000, availableFrom: 0 },
        { id: 'M', sheetsPerHour: 1000, availableFrom: 0 },
      ]),
    /重复/,
  );

  const engine = new SchedulingEngine(MACHINES);
  engine.addJob('A', 'P1', 1, 100, 'normal');
  assert.throws(() => engine.addJob('A', 'P1', 1, 100, 'normal'), /已存在/);
  assert.throws(() => engine.addJob('B', 'NOPE', 1, 100, 'normal'), /未知印机/);
  assert.throws(() => engine.addJob('B', 'P1', 0, 100, 'normal'), /priority/);
  assert.throws(() => engine.addJob('B', 'P1', 6, 100, 'normal'), /priority/);
  assert.throws(() => engine.addJob('B', 'P1', 1, 0, 'normal'), /sheets/);
  assert.throws(
    () => engine.addJob('B', 'P1', 1, 1_000_001, 'normal'),
    /sheets/,
  );
  assert.throws(
    () => engine.addJob('B', 'P1', 1, 100, 'uv' as never),
    /加工档/,
  );
  assert.throws(() => engine.queryJob('NOPE'), /未知作业/);
  assert.throws(() => engine.removeJob('NOPE'), /未知作业/);
  assert.throws(() => engine.updateJob('NOPE', { priority: 1 }), /未知作业/);
  assert.throws(() => engine.updateJob('A', { machineId: 'NOPE' }), /未知印机/);
});

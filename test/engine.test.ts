import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessExecution, validateDefinition } from '../src/index.js';
import type { ExecutionResult, ProcessDefinition } from '../src/index.js';

function step(result: ExecutionResult, id: string) {
  const found = result.steps.find((s) => s.id === id);
  assert.ok(found, `step ${id} should exist`);
  return found;
}

test('连续等待链：一次大幅推进与逐段累计结果一致', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'w1', kind: 'wait', durationMs: 1000, reminders: [400] },
      { id: 'w2', kind: 'wait', durationMs: 2000, reminders: [500, 1500] },
      { id: 'w3', kind: 'wait', durationMs: 3000 },
    ],
    dependencies: [
      { from: 'w1', to: 'w2' },
      { from: 'w2', to: 'w3' },
    ],
  };

  // 一次大幅推进，跨越整条链
  const big = new ProcessExecution(def, 100);
  big.advanceTime(100 + 1000 + 2000 + 3000);
  const bigResult = big.getResult();

  // 各步骤按依赖实际达成的时刻开始和结束，而非调用时刻
  assert.equal(step(bigResult, 'w1').waitStartedAt, 100);
  assert.equal(step(bigResult, 'w1').completedAt, 1100);
  assert.equal(step(bigResult, 'w2').waitStartedAt, 1100);
  assert.equal(step(bigResult, 'w2').completedAt, 3100);
  assert.equal(step(bigResult, 'w3').waitStartedAt, 3100);
  assert.equal(step(bigResult, 'w3').completedAt, 6100);

  // 多次小幅推进（不对齐任何事件边界）
  const small = new ProcessExecution(def, 100);
  let t = 100;
  while (t < 6100) {
    t = Math.min(t + 777, 6100);
    small.advanceTime(t);
  }
  assert.deepEqual(small.getResult(), bigResult);

  // 提醒记录
  assert.deepEqual(step(bigResult, 'w1').reminders, [{ offsetMs: 400, firedAt: 500, round: 1 }]);
  assert.deepEqual(step(bigResult, 'w2').reminders, [
    { offsetMs: 500, firedAt: 1600, round: 1 },
    { offsetMs: 1500, firedAt: 2600, round: 1 },
  ]);
});

test('人工确认早于等待结束：计时结束时完成并解锁后继', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'w', kind: 'wait', durationMs: 1000, requiresConfirmation: true },
      { id: 'm', kind: 'manual' },
    ],
    dependencies: [{ from: 'w', to: 'm' }],
  };
  const exec = new ProcessExecution(def, 0);
  exec.confirm('w', 400); // 确认早于计时结束
  assert.equal(step(exec.getResult(), 'w').status, 'unlocked'); // 尚未完成
  assert.equal(step(exec.getResult(), 'm').status, 'locked');
  exec.advanceTime(999);
  assert.equal(step(exec.getResult(), 'w').status, 'unlocked');
  exec.advanceTime(1000);
  const result = exec.getResult();
  assert.equal(step(result, 'w').completedAt, 1000); // 完成时刻取两个条件最后满足的时刻
  assert.equal(step(result, 'm').status, 'unlocked');
});

test('人工确认晚于等待结束：确认时刻完成并解锁后继', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'w', kind: 'wait', durationMs: 1000, requiresConfirmation: true },
      { id: 'm', kind: 'manual' },
    ],
    dependencies: [{ from: 'w', to: 'm' }],
  };
  const exec = new ProcessExecution(def, 0);
  exec.advanceTime(1500); // 计时已结束，但确认未到：阻断后继
  assert.equal(step(exec.getResult(), 'w').status, 'unlocked');
  assert.equal(step(exec.getResult(), 'm').status, 'locked');
  exec.confirm('w', 1500);
  const result = exec.getResult();
  assert.equal(step(result, 'w').completedAt, 1500);
  assert.equal(step(result, 'm').status, 'unlocked');
  exec.confirm('m', 1500);
  assert.equal(step(exec.getResult(), 'm').completedAt, 1500);
});

test('未解锁不能确认；重复确认不改变计时起点', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'a', kind: 'wait', durationMs: 100 },
      { id: 'b', kind: 'manual' },
    ],
    dependencies: [{ from: 'a', to: 'b' }],
  };
  const exec = new ProcessExecution(def, 0);
  assert.throws(() => exec.confirm('b', 0), /locked/);
  exec.advanceTime(100);
  exec.confirm('b', 100);
  exec.confirm('b', 200); // 重复确认：无效果
  const result = exec.getResult();
  assert.equal(step(result, 'b').completedAt, 100);
  assert.equal(step(result, 'a').waitStartedAt, 0);
});

test('并行执行中恰在提醒到期时回退一支：旧提醒先产生一次，另一支完全不变', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'start', kind: 'manual' },
      { id: 'b', kind: 'wait', durationMs: 1000, reminders: [500, 800] },
      { id: 'd', kind: 'wait', durationMs: 500 },
      { id: 'c', kind: 'wait', durationMs: 2000, reminders: [1000] },
    ],
    dependencies: [
      { from: 'start', to: 'b' },
      { from: 'start', to: 'c' },
      { from: 'b', to: 'd' },
    ],
  };
  const exec = new ProcessExecution(def, 0);
  exec.confirm('start', 0); // b、c 从 0 开始计时

  // 恰在 b 的第一个提醒到期时刻回退 b
  exec.revert('b', 500);
  let result = exec.getResult();
  // 到期旧提醒先产生一次并保留为历史
  assert.deepEqual(step(result, 'b').reminders, [{ offsetMs: 500, firedAt: 500, round: 1 }]);
  // b 从回退时刻重新计时
  assert.equal(step(result, 'b').status, 'unlocked');
  assert.equal(step(result, 'b').waitStartedAt, 500);
  assert.equal(step(result, 'b').round, 2);

  exec.advanceTime(2000);
  result = exec.getResult();
  // 旧轮未到期的提醒（800）永远不再出现；新一轮提醒从 500 起算
  assert.deepEqual(step(result, 'b').reminders, [
    { offsetMs: 500, firedAt: 500, round: 1 },
    { offsetMs: 500, firedAt: 1000, round: 2 },
    { offsetMs: 800, firedAt: 1300, round: 2 },
  ]);
  // 受影响后继重新执行
  assert.equal(step(result, 'b').completedAt, 1500);
  assert.equal(step(result, 'd').waitStartedAt, 1500);
  assert.equal(step(result, 'd').completedAt, 2000);
  // 另一支的计时和结果完全不变
  assert.equal(step(result, 'c').waitStartedAt, 0);
  assert.equal(step(result, 'c').completedAt, 2000);
  assert.deepEqual(step(result, 'c').reminders, [{ offsetMs: 1000, firedAt: 1000, round: 1 }]);
});

test('回退已完成的中间步骤：后续链失效并重新执行，旁支不受影响', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'a', kind: 'wait', durationMs: 100 },
      { id: 'b', kind: 'wait', durationMs: 100 },
      { id: 'c', kind: 'manual' },
      { id: 'side', kind: 'wait', durationMs: 1000 },
    ],
    dependencies: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'side' },
    ],
  };
  const exec = new ProcessExecution(def, 0);
  exec.advanceTime(200);
  exec.confirm('c', 200);
  assert.equal(step(exec.getResult(), 'c').status, 'completed');

  exec.revert('b', 200);
  let result = exec.getResult();
  assert.equal(step(result, 'a').status, 'completed'); // 影响范围之外
  assert.equal(step(result, 'a').completedAt, 100);
  assert.equal(step(result, 'b').status, 'unlocked');
  assert.equal(step(result, 'b').waitStartedAt, 200);
  assert.equal(step(result, 'c').status, 'locked'); // 确认与完成均失效
  assert.equal(step(result, 'c').confirmedAt, null);
  assert.equal(step(result, 'side').status, 'unlocked'); // 旁支不受影响
  assert.equal(step(result, 'side').waitStartedAt, 100);

  exec.advanceTime(300);
  exec.confirm('c', 300);
  result = exec.getResult();
  assert.equal(step(result, 'b').completedAt, 300);
  assert.equal(step(result, 'c').completedAt, 300);
});

test('回退锁定步骤抛错；时间不能倒退', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'a', kind: 'wait', durationMs: 100 },
      { id: 'b', kind: 'manual' },
    ],
    dependencies: [{ from: 'a', to: 'b' }],
  };
  const exec = new ProcessExecution(def, 0);
  assert.throws(() => exec.revert('b', 0), /locked/);
  exec.advanceTime(50);
  assert.throws(() => exec.advanceTime(49), /backwards/);
});

test('同一操作序列：大幅推进与小幅推进最终状态一致（含回退与确认）', () => {
  const def: ProcessDefinition = {
    steps: [
      { id: 'prep', kind: 'wait', durationMs: 500, reminders: [200] },
      { id: 'assemble', kind: 'wait', durationMs: 800, requiresConfirmation: true, reminders: [300, 700] },
      { id: 'inspect', kind: 'manual' },
      { id: 'cure', kind: 'wait', durationMs: 1200, reminders: [600] },
    ],
    dependencies: [
      { from: 'prep', to: 'assemble' },
      { from: 'assemble', to: 'inspect' },
      { from: 'prep', to: 'cure' },
    ],
  };

  // 操作脚本：[推进到 t, 操作...]
  const script: (readonly [number, string])[] = [
    [400, 'advance'],
    [400, 'confirm:assemble'], // 未解锁，应抛错 -> 跳过
    [600, 'advance'],
    [600, 'confirm:assemble'], // 确认早于计时结束（assemble 从 500 起，1300 结束）
    [1400, 'advance'],
    [1400, 'confirm:inspect'],
    [1500, 'revert:assemble'],
    [1500, 'confirm:assemble'],
    [3000, 'advance'],
    [3000, 'confirm:inspect'],
    [5000, 'advance'],
  ];

  const run = (advance: (exec: ProcessExecution, t: number) => void) => {
    const exec = new ProcessExecution(def, 0);
    for (const [t, op] of script) {
      const [kind, arg] = op.split(':');
      if (kind === 'advance') {
        advance(exec, t);
      } else if (kind === 'confirm') {
        try {
          exec.confirm(arg, t);
        } catch {
          // 未解锁确认：两种推进方式行为一致即可
        }
      } else if (kind === 'revert') {
        exec.revert(arg, t);
      }
    }
    return exec.getResult();
  };

  const big = run((exec, t) => exec.advanceTime(t));
  const small = run((exec, t) => {
    let cur = exec.getResult().now;
    while (cur < t) {
      cur = Math.min(cur + 137, t);
      exec.advanceTime(cur);
    }
  });
  assert.deepEqual(small, big);

  // 关键事实抽查
  assert.equal(step(big, 'assemble').waitStartedAt, 1500);
  assert.equal(step(big, 'assemble').completedAt, 2300);
  assert.equal(step(big, 'inspect').completedAt, 3000);
  assert.equal(step(big, 'cure').waitStartedAt, 500);
  assert.equal(step(big, 'cure').completedAt, 1700);
});

test('规模与性能：1000 步链、一次推进 30 天', () => {
  const n = 1000;
  const duration = 3_000_000; // 每步 50 分钟，链总长 1000 步 > 30 天
  const steps = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    kind: 'wait' as const,
    durationMs: duration,
    reminders: [1, duration - 1],
  }));
  const dependencies = Array.from({ length: n - 1 }, (_, i) => ({
    from: `s${i}`,
    to: `s${i + 1}`,
  }));
  const exec = new ProcessExecution({ steps, dependencies }, 0);
  const thirtyDays = 30 * 24 * 3600 * 1000;
  const started = Date.now();
  exec.advanceTime(thirtyDays);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `advance over 30 days took ${elapsed}ms`);
  const completedCount = Math.floor(thirtyDays / duration); // s0..s863 完成，s864 恰在边界解锁
  const result = exec.getResult();
  assert.equal(step(result, `s${completedCount - 1}`).status, 'completed');
  assert.equal(step(result, `s${completedCount}`).status, 'unlocked');
});

test('定义校验：重复编号、环、非法提醒', () => {
  assert.throws(
    () => validateDefinition({ steps: [{ id: 'a', kind: 'manual' }, { id: 'a', kind: 'manual' }], dependencies: [] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateDefinition({
        steps: [
          { id: 'a', kind: 'manual' },
          { id: 'b', kind: 'manual' },
        ],
        dependencies: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      validateDefinition({
        steps: [{ id: 'w', kind: 'wait', durationMs: 100, reminders: [100] }],
        dependencies: [],
      }),
    /less than durationMs/,
  );
  assert.throws(
    () =>
      validateDefinition({
        steps: [{ id: 'w', kind: 'wait', durationMs: 100, reminders: [1, 2, 3, 4] }],
        dependencies: [],
      }),
    /more than 3/,
  );
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessExecution,
  type ExecutionResult,
  type ProcessDefinition,
} from "../dist/index.js";

function stepSummary(result: ExecutionResult, id: string) {
  const step = result.steps[id];
  return {
    status: step.status,
    waitStartedAt: step.waitStartedAt,
    confirmedAt: step.confirmedAt,
    completedAt: step.completedAt,
  };
}

describe("连续等待链", () => {
  const chainDef: ProcessDefinition = {
    steps: [
      { id: "A", kind: "wait", durationMs: 100 },
      { id: "B", kind: "wait", durationMs: 200, dependsOn: ["A"], reminders: [50] },
      { id: "C", kind: "wait", durationMs: 50, dependsOn: ["B"] },
      { id: "D", kind: "manual", dependsOn: ["C"] },
    ],
  };

  it("一次大幅推进跨越全部时长，各步骤按依赖实际达成时刻开始和结束", () => {
    const exec = new ProcessExecution(chainDef, 0);
    exec.advanceTime(1000);
    const result = exec.getResult();
    assert.deepEqual(stepSummary(result, "A"), {
      status: "completed", waitStartedAt: 0, confirmedAt: null, completedAt: 100,
    });
    assert.deepEqual(stepSummary(result, "B"), {
      status: "completed", waitStartedAt: 100, confirmedAt: null, completedAt: 300,
    });
    assert.deepEqual(stepSummary(result, "C"), {
      status: "completed", waitStartedAt: 300, confirmedAt: null, completedAt: 350,
    });
    assert.equal(result.steps["D"].status, "unlocked");
    assert.deepEqual(
      result.reminders.map((r) => [r.stepId, r.offsetMs, r.at]),
      [["B", 50, 150]],
    );
  });

  it("逐段小幅推进得到完全一致的开始与完成时刻", () => {
    const big = new ProcessExecution(chainDef, 0);
    big.advanceTime(1000);

    const small = new ProcessExecution(chainDef, 0);
    for (const t of [40, 100, 150, 220, 300, 350, 700, 1000]) {
      small.advanceTime(t);
    }
    assert.deepEqual(small.getResult(), big.getResult());
  });
});

describe("等待步骤的人工环境确认", () => {
  const def: ProcessDefinition = {
    steps: [
      { id: "W", kind: "wait", durationMs: 100, requiresConfirmation: true },
      { id: "M", kind: "manual", dependsOn: ["W"] },
    ],
  };

  it("确认早于计时结束：完成时刻取计时结束时刻", () => {
    const exec = new ProcessExecution(def, 0);
    exec.confirm("W", 30);
    assert.equal(exec.getResult().steps["W"].status, "unlocked");
    assert.equal(exec.getResult().steps["M"].status, "locked");
    exec.advanceTime(100);
    const result = exec.getResult();
    assert.equal(result.steps["W"].completedAt, 100);
    assert.equal(result.steps["W"].confirmedAt, 30);
    assert.equal(result.steps["M"].status, "unlocked");
  });

  it("确认晚于计时结束：完成时刻取确认时刻，此前后继被阻断", () => {
    const exec = new ProcessExecution(def, 0);
    exec.advanceTime(500);
    assert.equal(exec.getResult().steps["W"].status, "unlocked");
    assert.equal(exec.getResult().steps["M"].status, "locked");
    exec.confirm("W", 600);
    const result = exec.getResult();
    assert.equal(result.steps["W"].completedAt, 600);
    assert.equal(result.steps["M"].status, "unlocked");
  });

  it("重复确认不改变计时起点与确认时刻", () => {
    const exec = new ProcessExecution(def, 0);
    exec.confirm("W", 30);
    exec.confirm("W", 80);
    exec.advanceTime(100);
    const result = exec.getResult();
    assert.equal(result.steps["W"].waitStartedAt, 0);
    assert.equal(result.steps["W"].confirmedAt, 30);
    assert.equal(result.steps["W"].completedAt, 100);
  });

  it("未解锁的步骤不能确认", () => {
    const exec = new ProcessExecution(def, 0);
    assert.throws(() => exec.confirm("M", 0), /locked/);
  });
});

describe("并行执行中的回退", () => {
  const def: ProcessDefinition = {
    steps: [
      { id: "A1", kind: "wait", durationMs: 1000, reminders: [300, 600] },
      { id: "A2", kind: "wait", durationMs: 500, dependsOn: ["A1"] },
      { id: "B1", kind: "wait", durationMs: 800 },
      { id: "B2", kind: "manual", dependsOn: ["B1"] },
    ],
  };

  it("恰在提醒到期时回退：旧提醒先产生，旧轮提醒此后不再出现，另一支完全不变", () => {
    const exec = new ProcessExecution(def, 0);
    exec.rollback("A1", 300);

    let result = exec.getResult();
    // 到期旧提醒先产生一次（第 0 轮）
    assert.deepEqual(
      result.reminders.map((r) => [r.stepId, r.offsetMs, r.at, r.round]),
      [["A1", 300, 300, 0]],
    );
    // 受影响步骤重置并重新计时
    assert.deepEqual(stepSummary(result, "A1"), {
      status: "unlocked", waitStartedAt: 300, confirmedAt: null, completedAt: null,
    });
    assert.equal(result.steps["A2"].status, "locked");

    exec.advanceTime(2000);
    result = exec.getResult();
    // 新一轮提醒在 600、900 产生；旧轮 600 的提醒不再出现
    assert.deepEqual(
      result.reminders.map((r) => [r.stepId, r.offsetMs, r.at, r.round]),
      [
        ["A1", 300, 300, 0],
        ["A1", 300, 600, 1],
        ["A1", 600, 900, 1],
      ],
    );
    // 受影响后继重新执行
    assert.deepEqual(stepSummary(result, "A1"), {
      status: "completed", waitStartedAt: 300, confirmedAt: null, completedAt: 1300,
    });
    assert.deepEqual(stepSummary(result, "A2"), {
      status: "completed", waitStartedAt: 1300, confirmedAt: null, completedAt: 1800,
    });
    // 另一支的计时与结果完全不变
    assert.deepEqual(stepSummary(result, "B1"), {
      status: "completed", waitStartedAt: 0, confirmedAt: null, completedAt: 800,
    });
    assert.equal(result.steps["B2"].status, "unlocked");
  });

  it("回退已确认步骤后确认事实失效，需重新确认", () => {
    const confirmDef: ProcessDefinition = {
      steps: [
        { id: "W", kind: "wait", durationMs: 100, requiresConfirmation: true },
        { id: "N", kind: "wait", durationMs: 100, dependsOn: ["W"] },
      ],
    };
    const exec = new ProcessExecution(confirmDef, 0);
    exec.confirm("W", 10);
    exec.advanceTime(100);
    assert.equal(exec.getResult().steps["W"].status, "completed");
    exec.rollback("W", 200);
    const result = exec.getResult();
    assert.deepEqual(stepSummary(result, "W"), {
      status: "unlocked", waitStartedAt: 200, confirmedAt: null, completedAt: null,
    });
    exec.advanceTime(1000);
    // 计时重新计满，但确认已失效，必须重新确认才能完成
    assert.equal(exec.getResult().steps["W"].status, "unlocked");
    exec.confirm("W", 1000);
    assert.equal(exec.getResult().steps["W"].completedAt, 1000);
    assert.equal(exec.getResult().steps["N"].waitStartedAt, 1000);
  });

  it("不能回退未解锁的步骤", () => {
    const exec = new ProcessExecution(def, 0);
    assert.throws(() => exec.rollback("A2", 100), /locked/);
  });
});

describe("推进粒度等价性", () => {
  const def: ProcessDefinition = {
    steps: [
      { id: "S1", kind: "wait", durationMs: 400, reminders: [100, 250] },
      { id: "S2", kind: "wait", durationMs: 300, dependsOn: ["S1"], requiresConfirmation: true },
      { id: "S3", kind: "manual", dependsOn: ["S2"] },
      { id: "P1", kind: "wait", durationMs: 900, reminders: [450] },
      { id: "P2", kind: "wait", durationMs: 100, dependsOn: ["P1"] },
    ],
  };

  function runBig(): ExecutionResult {
    const exec = new ProcessExecution(def, 0);
    exec.rollback("S1", 250);
    exec.confirm("S2", 800);
    exec.advanceTime(5000);
    exec.confirm("S3", 5000);
    return exec.getResult();
  }

  function runSmall(): ExecutionResult {
    const exec = new ProcessExecution(def, 0);
    for (let t = 50; t < 250; t += 50) exec.advanceTime(t);
    exec.rollback("S1", 250);
    for (let t = 300; t <= 800; t += 100) exec.advanceTime(t);
    exec.confirm("S2", 800);
    for (let t = 1000; t <= 5000; t += 250) exec.advanceTime(t);
    exec.confirm("S3", 5000);
    return exec.getResult();
  }

  it("一次大幅推进与多次小幅推进得到相同的步骤状态、完成时刻和提醒记录", () => {
    assert.deepEqual(runSmall(), runBig());
  });
});

describe("规模与性能", () => {
  it("1000 步等待链一次推进 30 天，2 秒内完成", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const count = 1000;
    const steps = [];
    for (let i = 0; i < count; i++) {
      steps.push({
        id: `S${i}`,
        kind: "wait" as const,
        durationMs: (30 * dayMs) / count,
        dependsOn: i === 0 ? [] : [`S${i - 1}`],
        reminders: [1],
      });
    }
    const exec = new ProcessExecution({ steps }, 0);
    const started = process.hrtime.bigint();
    exec.advanceTime(30 * dayMs);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const result = exec.getResult();
    assert.equal(result.steps[`S${count - 1}`].status, "completed");
    assert.equal(result.steps[`S${count - 1}`].completedAt, 30 * dayMs);
    assert.equal(result.reminders.length, count);
    assert.ok(elapsedMs < 2000, `advance took ${elapsedMs}ms`);
  });
});

describe("输入校验", () => {
  it("拒绝回退业务时间", () => {
    const exec = new ProcessExecution({ steps: [] }, 100);
    assert.throws(() => exec.advanceTime(99));
  });

  it("拒绝非法定义", () => {
    assert.throws(
      () => new ProcessExecution({ steps: [{ id: "X", kind: "wait", durationMs: 0 }] }, 0),
    );
    assert.throws(
      () =>
        new ProcessExecution(
          { steps: [{ id: "X", kind: "wait", durationMs: 10, reminders: [10] }] },
          0,
        ),
    );
    assert.throws(
      () =>
        new ProcessExecution(
          {
            steps: [
              { id: "X", kind: "manual" },
              { id: "X", kind: "manual" },
            ],
          },
          0,
        ),
    );
    assert.throws(
      () =>
        new ProcessExecution(
          { steps: [{ id: "X", kind: "manual", dependsOn: ["Y"] }] },
          0,
        ),
    );
  });
});

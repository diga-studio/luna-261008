import assert from "node:assert/strict";
import test from "node:test";
import {
  PLANNING_WINDOW_SLOTS,
  WorkshopScheduler,
  type Adjustment,
  type Job,
  type Machine,
  type Placement,
} from "../src/index.js";

// ---------- 测试辅助：独立实现的暴力求解与可行性校验 ----------

function bruteForceOptimal(
  machines: readonly Machine[],
  jobs: readonly Job[],
  current: readonly Placement[],
  adjustment: Adjustment,
): { changed: number; displacement: number } | null {
  const ops = jobs.flatMap((j) =>
    j.operations.map((o, idx) => ({ ...o, jobId: j.id, indexInJob: idx })),
  );
  const currentById = new Map(current.map((p) => [p.operationId, p]));
  const movable = ops.filter((o) => {
    const p = currentById.get(o.id)!;
    return !p.locked && o.id !== adjustment.operationId;
  });
  const domains = movable.map((o) => {
    const cur = currentById.get(o.id)!;
    const out: { machineId: string; start: number }[] = [];
    for (const m of machines) {
      if (m.type !== o.machineType) continue;
      for (const iv of m.availability) {
        for (let s = Math.max(iv.start, 0); s + o.duration <= Math.min(iv.end, PLANNING_WINDOW_SLOTS); s++) {
          out.push({ machineId: m.id, start: s });
        }
      }
    }
    void cur;
    return out;
  });

  let best: { changed: number; displacement: number } | null = null;
  const chosen = new Array<{ machineId: string; start: number }>(movable.length);

  const fullCheck = (): boolean => {
    const all: { op: (typeof ops)[number]; machineId: string; start: number }[] = [];
    for (const o of ops) {
      const cur = currentById.get(o.id)!;
      if (cur.locked) all.push({ op: o, machineId: cur.machineId, start: cur.start });
      else if (o.id === adjustment.operationId)
        all.push({ op: o, machineId: adjustment.machineId, start: adjustment.start });
    }
    movable.forEach((o, i) => all.push({ op: o, ...chosen[i]! }));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.machineId === b.machineId) {
          if (a.start < b.start + b.op.duration && b.start < a.start + a.op.duration) return false;
        }
        if (a.op.jobId === b.op.jobId) {
          if (a.op.indexInJob < b.op.indexInJob && b.start < a.start + a.op.duration) return false;
          if (b.op.indexInJob < a.op.indexInJob && a.start < b.start + b.op.duration) return false;
        }
      }
    }
    return true;
  };

  const dfs = (k: number): void => {
    if (k === movable.length) {
      if (!fullCheck()) return;
      let changed = 0;
      let displacement = 0;
      movable.forEach((o, i) => {
        const cur = currentById.get(o.id)!;
        const c = chosen[i]!;
        if (c.machineId !== cur.machineId || c.start !== cur.start) {
          changed += 1;
          displacement += Math.abs(c.start - cur.start);
        }
      });
      if (
        best === null ||
        changed < best.changed ||
        (changed === best.changed && displacement < best.displacement)
      ) {
        best = { changed, displacement };
      }
      return;
    }
    for (const cand of domains[k]!) {
      chosen[k] = cand;
      dfs(k + 1);
    }
  };
  dfs(0);
  return best;
}

function assertFeasible(
  machines: readonly Machine[],
  jobs: readonly Job[],
  placements: readonly Placement[],
  original: readonly Placement[],
): void {
  const byId = new Map(placements.map((p) => [p.operationId, p]));
  const ops = jobs.flatMap((j) =>
    j.operations.map((o, idx) => ({ ...o, jobId: j.id, indexInJob: idx })),
  );
  assert.equal(placements.length, ops.length, "每道工序必须恰好安排一次");
  for (const o of ops) {
    const p = byId.get(o.id);
    assert.ok(p, `缺少工序 ${o.id} 的安排`);
    const machine = machines.find((m) => m.id === p.machineId);
    assert.ok(machine, `工序 ${o.id} 安排了不存在的机器`);
    assert.equal(machine.type, o.machineType, `工序 ${o.id} 机器类型不匹配`);
    assert.ok(p.start >= 0 && p.start + o.duration <= PLANNING_WINDOW_SLOTS, `工序 ${o.id} 超出规划窗口`);
    assert.ok(
      machine.availability.some((iv) => iv.start <= p.start && p.start + o.duration <= iv.end),
      `工序 ${o.id} 未完整落在机器可用区间内`,
    );
  }
  const placed = ops.map((o) => ({ op: o, p: byId.get(o.id)! }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.p.machineId === b.p.machineId) {
        assert.ok(
          a.p.start + a.op.duration <= b.p.start || b.p.start + b.op.duration <= a.p.start,
          `机器 ${a.p.machineId} 上工序 ${a.op.id} 与 ${b.op.id} 占用重叠`,
        );
      }
      if (a.op.jobId === b.op.jobId && a.op.indexInJob < b.op.indexInJob) {
        assert.ok(
          b.p.start >= a.p.start + a.op.duration,
          `作业 ${a.op.jobId} 中 ${b.op.id} 开工早于 ${a.op.id} 完工`,
        );
      }
    }
  }
  for (const orig of original) {
    if (!orig.locked) continue;
    const p = byId.get(orig.operationId)!;
    assert.equal(p.machineId, orig.machineId, `锁定工序 ${orig.operationId} 的机器被改变`);
    assert.equal(p.start, orig.start, `锁定工序 ${orig.operationId} 的开工时间被改变`);
  }
}

// ---------- 场景数据 ----------

/**
 * M1/M2 均为 A 类机器。J1: P1→P2(锁定 M1@8)；J2: Q1；J3: R1(锁定 M2@4)。
 * 调整 Q1 → M1@2 后，P1 在 M1 上被 Q1[2,6)… 实际 Q1 时长 6 占 [2,8)，
 * P1 只能换到 M2 并提前到 0（M2@[4,8) 被锁定的 R1 占用）。
 */
function buildScenario() {
  const machines: Machine[] = [
    { id: "M1", type: "A", availability: [{ start: 0, end: 48 }] },
    { id: "M2", type: "A", availability: [{ start: 0, end: 48 }] },
  ];
  const jobs: Job[] = [
    {
      id: "J1",
      operations: [
        { id: "P1", machineType: "A", duration: 4 },
        { id: "P2", machineType: "A", duration: 4 },
      ],
    },
    { id: "J2", operations: [{ id: "Q1", machineType: "A", duration: 6 }] },
    { id: "J3", operations: [{ id: "R1", machineType: "A", duration: 4 }] },
  ];
  const current: Placement[] = [
    { operationId: "P1", machineId: "M1", start: 4, locked: false },
    { operationId: "P2", machineId: "M1", start: 8, locked: true },
    { operationId: "Q1", machineId: "M2", start: 8, locked: false },
    { operationId: "R1", machineId: "M2", start: 4, locked: true },
  ];
  return { machines, jobs, current };
}

// ---------- 测试 ----------

test("跨作业换机并提前以守住未来锁定后继，且目标最优", () => {
  const { machines, jobs, current } = buildScenario();
  const scheduler = new WorkshopScheduler(machines, jobs, current);
  const adjustment: Adjustment = { operationId: "Q1", machineId: "M1", start: 2 };

  const preview = scheduler.preview(adjustment);
  if (!preview.ok) assert.fail(`预览应成功: ${preview.reason}`);

  // 预览不改变当前排程
  assert.deepEqual(scheduler.placements, current);

  // 指定调整必须兑现
  const q1 = preview.placements.find((p) => p.operationId === "Q1")!;
  assert.equal(q1.machineId, "M1");
  assert.equal(q1.start, 2);

  // 资源占用、依赖关系、锁定安排
  assertFeasible(machines, jobs, preview.placements, current);

  // 与独立暴力求解比对最优目标值
  const optimal = bruteForceOptimal(machines, jobs, current, adjustment);
  if (optimal === null) assert.fail("暴力求解应存在可行解");
  assert.equal(preview.changedCount, optimal.changed, "变化工序数应达到最少");
  assert.equal(preview.totalDisplacement, optimal.displacement, "开工时间绝对位移总和应达到最小");

  // 该场景下唯一最优：P1 换到 M2 并提前到 0
  assert.equal(preview.changedCount, 1);
  assert.equal(preview.totalDisplacement, 4);
  const p1 = preview.placements.find((p) => p.operationId === "P1")!;
  assert.equal(p1.machineId, "M2");
  assert.equal(p1.start, 0);

  // 应用后整体替换当前排程
  const applied = scheduler.apply(adjustment);
  if (!applied.ok) assert.fail("应用应成功");
  assert.deepEqual(scheduler.placements, applied.placements);
  assertFeasible(machines, jobs, scheduler.placements, current);
});

test("无解调整：预览与应用均不改变原排程", () => {
  const { machines, jobs, current } = buildScenario();
  const scheduler = new WorkshopScheduler(machines, jobs, current);

  // P1 移到 M1@8：与锁定的 P2(M1@[8,12)) 重叠，且违反 P1→P2 先后约束，确实无解
  const bad: Adjustment = { operationId: "P1", machineId: "M1", start: 8 };
  assert.equal(bruteForceOptimal(machines, jobs, current, bad), null, "暴力求解确认无解");

  const preview = scheduler.preview(bad);
  assert.equal(preview.ok, false);
  assert.deepEqual(scheduler.placements, current, "预览失败不得改变当前排程");

  const applied = scheduler.apply(bad);
  assert.equal(applied.ok, false);
  assert.deepEqual(scheduler.placements, current, "应用失败不得留下部分调整状态");

  // 失败之后仍可正常进行其他调整
  const good = scheduler.apply({ operationId: "Q1", machineId: "M1", start: 2 });
  if (!good.ok) assert.fail("失败之后仍可正常进行其他调整");
});

test("非法调整被拒绝：锁定工序、类型不匹配、超出可用区间", () => {
  const { machines, jobs, current } = buildScenario();
  const scheduler = new WorkshopScheduler(machines, jobs, current);

  assert.equal(scheduler.preview({ operationId: "P2", machineId: "M1", start: 0 }).ok, false);
  assert.equal(scheduler.preview({ operationId: "P1", machineId: "MX", start: 0 }).ok, false);
  assert.equal(scheduler.preview({ operationId: "P1", machineId: "M1", start: 46 }).ok, false);
  assert.deepEqual(scheduler.placements, current);
});

test("占用区间必须完整落在机器可用时间内，不能跨停机暂停", () => {
  // M1 在 [4,8) 停机；B1 时长 4，放在 M1@4 会跨停机，放在 M1@10 合法
  const machines: Machine[] = [
    { id: "M1", type: "A", availability: [{ start: 0, end: 4 }, { start: 8, end: 48 }] },
    { id: "M2", type: "A", availability: [{ start: 0, end: 48 }] },
  ];
  const jobs: Job[] = [
    { id: "J1", operations: [{ id: "A1", machineType: "A", duration: 4 }] },
    { id: "J2", operations: [{ id: "B1", machineType: "A", duration: 4 }] },
  ];
  const current: Placement[] = [
    { operationId: "A1", machineId: "M1", start: 0, locked: true },
    { operationId: "B1", machineId: "M2", start: 0, locked: false },
  ];
  const scheduler = new WorkshopScheduler(machines, jobs, current);

  const across = scheduler.preview({ operationId: "B1", machineId: "M1", start: 4 });
  assert.equal(across.ok, false, "跨停机暂停的调整应被拒绝");

  const fits = scheduler.preview({ operationId: "B1", machineId: "M1", start: 10 });
  if (!fits.ok) assert.fail("落在可用区间内的调整应可行");
  assertFeasible(machines, jobs, fits.placements, current);
  assert.deepEqual(scheduler.placements, current, "预览不得改变当前排程");
});

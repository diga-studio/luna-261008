import assert from "node:assert/strict";
import { HORIZON_SLOTS } from "../src/index.js";
import type {
  AdjustmentRequest,
  Problem,
  Schedule,
} from "../src/index.js";

/** 独立校验一个排程的全部硬约束。 */
export function assertLegalSchedule(problem: Problem, schedule: Schedule): void {
  const machineById = new Map(problem.machines.map((m) => [m.id, m]));
  const placementByOp = new Map(schedule.placements.map((p) => [p.opId, p]));

  // 每道工序恰好落位一次。
  const allOps = problem.jobs.flatMap((j) => j.operations);
  assert.equal(schedule.placements.length, allOps.length, "落位数量应等于工序数量");
  for (const op of allOps) {
    assert.ok(placementByOp.has(op.id), `工序 ${op.id} 缺少落位`);
  }

  for (const op of allOps) {
    const p = placementByOp.get(op.id)!;
    const machine = machineById.get(p.machineId);
    assert.ok(machine, `工序 ${op.id} 落在未知机器 ${p.machineId}`);
    assert.equal(machine!.type, op.machineType, `工序 ${op.id} 机器类型不符`);
    assert.ok(Number.isInteger(p.start), `工序 ${op.id} 开工时间应为整数格`);
    assert.ok(p.start >= 0 && p.start + op.duration <= HORIZON_SLOTS,
      `工序 ${op.id} 超出规划窗口`);
    const end = p.start + op.duration;
    assert.ok(
      machine!.available.some((iv) => iv.start <= p.start && end <= iv.end),
      `工序 ${op.id} 未完整落在机器可用时间内`,
    );
  }

  // 作业内先后约束。
  for (const job of problem.jobs) {
    for (let i = 1; i < job.operations.length; i++) {
      const prev = placementByOp.get(job.operations[i - 1]!.id)!;
      const cur = placementByOp.get(job.operations[i]!.id)!;
      assert.ok(
        cur.start >= prev.start + job.operations[i - 1]!.duration,
        `作业 ${job.id} 工序顺序被破坏`,
      );
    }
  }

  // 机器容量：同一机器上任意两工序不重叠。
  for (const machine of problem.machines) {
    const onMachine = allOps
      .map((op) => ({ op, p: placementByOp.get(op.id)! }))
      .filter(({ p }) => p.machineId === machine.id)
      .map(({ op, p }) => ({ start: p.start, end: p.start + op.duration }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < onMachine.length; i++) {
      assert.ok(
        onMachine[i]!.start >= onMachine[i - 1]!.end,
        `机器 ${machine.id} 上工序重叠`,
      );
    }
  }
}

/** 校验锁定工序在新排程中原样保留。 */
export function assertLockedPreserved(before: Schedule, after: Schedule): void {
  const afterByOp = new Map(after.placements.map((p) => [p.opId, p]));
  for (const p of before.placements) {
    if (!p.locked) continue;
    const q = afterByOp.get(p.opId);
    assert.ok(q, `锁定工序 ${p.opId} 丢失`);
    assert.equal(q!.machineId, p.machineId, `锁定工序 ${p.opId} 机器被改动`);
    assert.equal(q!.start, p.start, `锁定工序 ${p.opId} 开工时间被改动`);
  }
}

export interface Optimum {
  changedCount: number;
  totalDeviation: number;
}

/**
 * 独立暴力枚举：在锁定工序与目标工序固定、其余工序任意重排的所有合法排程中，
 * 求 (变化工序数, 开工时间绝对位移总和) 的字典序最小值。
 */
export function bruteForceOptimum(
  problem: Problem,
  current: Schedule,
  request: AdjustmentRequest,
): Optimum | null {
  const machineById = new Map(problem.machines.map((m) => [m.id, m]));
  const currentByOp = new Map(current.placements.map((p) => [p.opId, p]));
  const allOps = problem.jobs.flatMap((j) =>
    j.operations.map((op, index) => ({ op, job: j, index })),
  );

  const fixed = new Map<string, { machineId: string; start: number }>();
  for (const p of current.placements) {
    if (p.locked) fixed.set(p.opId, { machineId: p.machineId, start: p.start });
  }
  fixed.set(request.opId, { machineId: request.machineId, start: request.start });

  const free = allOps.filter(({ op }) => !fixed.has(op.id));

  interface Cand { machineId: string; start: number }
  const domains: Cand[][] = free.map(({ op }) => {
    const list: Cand[] = [];
    for (const m of problem.machines) {
      if (m.type !== op.machineType) continue;
      for (let s = 0; s + op.duration <= HORIZON_SLOTS; s++) {
        if (m.available.some((iv) => iv.start <= s && s + op.duration <= iv.end)) {
          list.push({ machineId: m.id, start: s });
        }
      }
    }
    return list;
  });

  let best: Optimum | null = null;
  const assignment = new Map<string, Cand>();

  const legalSoFar = (): boolean => {
    // 机器不重叠。
    const byMachine = new Map<string, Array<[number, number]>>();
    const all = new Map([...fixed, ...assignment]);
    for (const [opId, a] of all) {
      const op = allOps.find((o) => o.op.id === opId)!.op;
      const list = byMachine.get(a.machineId) ?? [];
      const end = a.start + op.duration;
      if (list.some(([s, e]) => s < end && a.start < e)) return false;
      list.push([a.start, end]);
      byMachine.set(a.machineId, list);
    }
    // 先后约束（只检查双方都已确定的）。
    for (const job of problem.jobs) {
      for (let i = 1; i < job.operations.length; i++) {
        const prev = all.get(job.operations[i - 1]!.id);
        const cur = all.get(job.operations[i]!.id);
        if (prev && cur && cur.start < prev.start + job.operations[i - 1]!.duration) {
          return false;
        }
      }
    }
    return true;
  };

  const dfs = (i: number): void => {
    if (i === free.length) {
      let changed = 0;
      let deviation = 0;
      for (const { op } of free) {
        const a = assignment.get(op.id)!;
        const orig = currentByOp.get(op.id)!;
        if (a.machineId !== orig.machineId || a.start !== orig.start) {
          changed++;
          deviation += Math.abs(a.start - orig.start);
        }
      }
      if (!best || changed < best.changedCount ||
          (changed === best.changedCount && deviation < best.totalDeviation)) {
        best = { changedCount: changed, totalDeviation: deviation };
      }
      return;
    }
    const { op } = free[i]!;
    for (const cand of domains[i]!) {
      assignment.set(op.id, cand);
      if (legalSoFar()) dfs(i + 1);
      assignment.delete(op.id);
    }
  };

  // 固定落位本身必须合法（类型、窗口、可用时间）。
  for (const [opId, a] of fixed) {
    const op = allOps.find((o) => o.op.id === opId)!.op;
    const m = machineById.get(a.machineId);
    if (!m || m.type !== op.machineType) return null;
    if (a.start < 0 || a.start + op.duration > HORIZON_SLOTS) return null;
    if (!m.available.some((iv) => iv.start <= a.start && a.start + op.duration <= iv.end)) {
      return null;
    }
  }
  if (!legalSoFar()) return null;

  dfs(0);
  return best;
}

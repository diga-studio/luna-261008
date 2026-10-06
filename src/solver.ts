import { HORIZON_SLOTS } from "./types.js";
import type {
  AdjustmentRequest,
  Problem,
  Schedule,
  SolveResult,
} from "./types.js";
import {
  buildIndex,
  fitsAvailability,
  fitsHorizon,
  overlaps,
  type ModelIndex,
  type OpContext,
} from "./model.js";

interface Assignment {
  machineId: string;
  start: number;
}

interface Occupied {
  start: number;
  end: number;
}

interface Candidate extends Assignment {
  /** 相对原计划是否变化（机器或开工时间）：0 或 1。 */
  changed: number;
  /** 开工时间绝对位移。 */
  deviation: number;
}

function fail(reason: string): SolveResult {
  return { ok: false, reason };
}

/**
 * 在给定当前排程与调整请求下，搜索满足全部约束的最优新排程。
 * 目标（字典序）：先最小化变化工序数，再最小化开工时间绝对位移总和。
 * 目标工序与锁定工序不计入这两个目标。
 */
export function solveAdjustment(
  problem: Problem,
  current: Schedule,
  request: AdjustmentRequest,
): SolveResult {
  const index = buildIndex(problem, current);

  const targetCtx = index.opsById.get(request.opId);
  if (!targetCtx) return fail(`未知工序: ${request.opId}`);
  const targetPlacement = index.placementsByOpId.get(request.opId);
  if (!targetPlacement) return fail(`工序缺少排程落位: ${request.opId}`);
  const targetMachine = index.machinesById.get(request.machineId);
  if (!targetMachine) return fail(`未知机器: ${request.machineId}`);
  if (targetPlacement.locked) return fail(`目标工序已锁定: ${request.opId}`);
  if (targetMachine.type !== targetCtx.op.machineType) {
    return fail(`机器 ${request.machineId} 类型与工序 ${request.opId} 要求不符`);
  }
  if (!fitsHorizon(request.start, targetCtx.op.duration)) {
    return fail(`目标工序超出规划窗口: ${request.opId}`);
  }
  if (!fitsAvailability(targetMachine, request.start, targetCtx.op.duration)) {
    return fail(`目标工序超出机器可用时间: ${request.opId}`);
  }

  // 固定落位：全部锁定工序 + 目标工序。
  const fixed = new Map<string, Assignment>();
  for (const placement of current.placements) {
    if (placement.locked) {
      fixed.set(placement.opId, {
        machineId: placement.machineId,
        start: placement.start,
      });
    }
  }
  fixed.set(request.opId, { machineId: request.machineId, start: request.start });

  // 固定落位之间的资源冲突检查。
  const occupied = new Map<string, Occupied[]>();
  for (const [opId, assignment] of fixed) {
    const ctx = index.opsById.get(opId);
    if (!ctx) return fail(`排程包含未知工序: ${opId}`);
    const end = assignment.start + ctx.op.duration;
    const list = occupied.get(assignment.machineId) ?? [];
    if (list.some((iv) => overlaps(iv.start, iv.end, assignment.start, end))) {
      return fail(`固定落位在机器 ${assignment.machineId} 上冲突`);
    }
    list.push({ start: assignment.start, end });
    occupied.set(assignment.machineId, list);
  }

  // 固定落位之间的先后约束检查。
  for (const job of problem.jobs) {
    for (let i = 1; i < job.operations.length; i++) {
      const prevOp = job.operations[i - 1]!;
      const curOp = job.operations[i]!;
      const prev = fixed.get(prevOp.id);
      const cur = fixed.get(curOp.id);
      if (prev && cur && cur.start < prev.start + prevOp.duration) {
        return fail(`固定落位违反作业 ${job.id} 的工序顺序`);
      }
    }
  }

  // 自由工序：未锁定且非目标。按作业链顺序排列，保证前序先于后继被赋值。
  const freeOps: OpContext[] = [];
  for (const job of problem.jobs) {
    job.operations.forEach((op, opIndex) => {
      if (!fixed.has(op.id)) freeOps.push({ op, job, index: opIndex });
    });
  }

  // 每个自由工序的候选落位，按 (是否变化, 位移, 机器, 开工) 排序，原落位优先。
  const candidates: Candidate[][] = freeOps.map((ctx) => {
    const original = index.placementsByOpId.get(ctx.op.id);
    if (!original) throw new Error(`工序缺少排程落位: ${ctx.op.id}`);
    const list: Candidate[] = [];
    for (const machine of problem.machines) {
      if (machine.type !== ctx.op.machineType) continue;
      const lastStart = HORIZON_SLOTS - ctx.op.duration;
      for (let start = 0; start <= lastStart; start++) {
        if (!fitsAvailability(machine, start, ctx.op.duration)) continue;
        const changed =
          machine.id === original.machineId && start === original.start ? 0 : 1;
        list.push({
          machineId: machine.id,
          start,
          changed,
          deviation: Math.abs(start - original.start),
        });
      }
    }
    list.sort(
      (a, b) =>
        a.changed - b.changed ||
        a.deviation - b.deviation ||
        a.machineId.localeCompare(b.machineId) ||
        a.start - b.start,
    );
    return list;
  });

  const assigned = new Map<string, Assignment>();
  interface Best {
    changed: number;
    deviation: number;
    plan: Map<string, Assignment>;
  }
  const bestRef: { current: Best | null } = { current: null };

  const lookup = (opId: string): Assignment | undefined =>
    assigned.get(opId) ?? fixed.get(opId);

  const dfs = (i: number, changed: number, deviation: number): void => {
    const best = bestRef.current;
    if (best && (changed > best.changed || (changed === best.changed && deviation >= best.deviation))) {
      return;
    }
    if (i === freeOps.length) {
      bestRef.current = { changed, deviation, plan: new Map(assigned) };
      return;
    }
    const ctx = freeOps[i]!;
    const duration = ctx.op.duration;
    for (const cand of candidates[i]!) {
      const nextChanged = changed + cand.changed;
      const nextDeviation = deviation + (cand.changed ? cand.deviation : 0);
      const incumbent = bestRef.current;
      if (incumbent && (nextChanged > incumbent.changed || (nextChanged === incumbent.changed && nextDeviation >= incumbent.deviation))) {
        continue;
      }
      // 前序约束：前序已赋值（固定或已搜索）。
      if (ctx.index > 0) {
        const predOp = ctx.job.operations[ctx.index - 1]!;
        const pred = lookup(predOp.id);
        if (pred && cand.start < pred.start + predOp.duration) continue;
      }
      // 后继约束：后继为固定落位时立即检查。
      if (ctx.index < ctx.job.operations.length - 1) {
        const succOp = ctx.job.operations[ctx.index + 1]!;
        const succ = fixed.get(succOp.id);
        if (succ && cand.start + duration > succ.start) continue;
      }
      // 机器容量约束。
      const list = occupied.get(cand.machineId);
      const end = cand.start + duration;
      if (list && list.some((iv) => overlaps(iv.start, iv.end, cand.start, end))) {
        continue;
      }
      assigned.set(ctx.op.id, cand);
      const iv: Occupied = { start: cand.start, end };
      if (list) list.push(iv);
      else occupied.set(cand.machineId, [iv]);
      dfs(i + 1, nextChanged, nextDeviation);
      assigned.delete(ctx.op.id);
      occupied.get(cand.machineId)!.pop();
    }
  };

  dfs(0, 0, 0);

  const best = bestRef.current;
  if (!best) return fail("不存在满足约束的排程");

  const bestPlan: Map<string, Assignment> = best.plan;
  const placements = current.placements.map((placement) => {
    if (placement.locked) return { ...placement };
    const assignment =
      placement.opId === request.opId
        ? fixed.get(request.opId)!
        : bestPlan.get(placement.opId)!;
    return {
      opId: placement.opId,
      machineId: assignment.machineId,
      start: assignment.start,
      locked: placement.locked,
    };
  });

  return {
    ok: true,
    schedule: { placements },
    changedCount: best.changed,
    totalDeviation: best.deviation,
  };
}

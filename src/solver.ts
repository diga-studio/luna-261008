import {
  PLANNING_WINDOW_SLOTS,
  type Adjustment,
  type Job,
  type Machine,
  type Placement,
} from "./types.js";

/** 求解输入：当前排程 + 一次调整。 */
export interface SolveInput {
  readonly machines: readonly Machine[];
  readonly jobs: readonly Job[];
  readonly current: readonly Placement[];
  readonly adjustment: Adjustment;
}

/** 求解输出：最优的完整安排，或 null 表示无解。 */
export interface SolveOutput {
  readonly placements: readonly Placement[];
  readonly changedCount: number;
  readonly totalDisplacement: number;
}

interface OpInfo {
  readonly id: string;
  readonly jobId: string;
  readonly indexInJob: number;
  readonly machineType: string;
  readonly duration: number;
}

interface Candidate {
  readonly machineId: string;
  readonly start: number;
  readonly changed: boolean;
  readonly displacement: number;
}

/** 校验调整本身是否合法（工序存在、未锁定、机器类型匹配、落在窗口与可用区间内）。 */
export function validateAdjustment(
  machines: readonly Machine[],
  jobs: readonly Job[],
  current: readonly Placement[],
  adjustment: Adjustment,
): string | null {
  const op = findOp(jobs, adjustment.operationId);
  if (!op) return `unknown operation: ${adjustment.operationId}`;
  const placement = current.find((p) => p.operationId === adjustment.operationId);
  if (!placement) return `operation not scheduled: ${adjustment.operationId}`;
  if (placement.locked) return `operation is locked: ${adjustment.operationId}`;
  const machine = machines.find((m) => m.id === adjustment.machineId);
  if (!machine) return `unknown machine: ${adjustment.machineId}`;
  if (machine.type !== op.machineType) {
    return `machine ${machine.id} type ${machine.type} does not match required ${op.machineType}`;
  }
  if (!fitsAvailability(machine, adjustment.start, op.duration)) {
    return `operation ${op.id} does not fit machine ${machine.id} availability/window at ${adjustment.start}`;
  }
  return null;
}

function findOp(jobs: readonly Job[], operationId: string): OpInfo | null {
  for (const job of jobs) {
    for (let i = 0; i < job.operations.length; i++) {
      const op = job.operations[i]!;
      if (op.id === operationId) {
        return {
          id: op.id,
          jobId: job.id,
          indexInJob: i,
          machineType: op.machineType,
          duration: op.duration,
        };
      }
    }
  }
  return null;
}

/** 占用区间 [start, start+duration) 必须完整落在窗口内且包含于某一个可用区间。 */
function fitsAvailability(machine: Machine, start: number, duration: number): boolean {
  if (start < 0 || start + duration > PLANNING_WINDOW_SLOTS) return false;
  return machine.availability.some((iv) => iv.start <= start && start + duration <= iv.end);
}

/**
 * 在遵守锁定、依赖、资源约束的前提下，按
 * (变化工序数, 开工时间绝对位移总和) 的字典序求最优排程。
 * 目标工序不计入这两个目标。无解返回 null。
 */
export function solve(input: SolveInput): SolveOutput | null {
  if (validateAdjustment(input.machines, input.jobs, input.current, input.adjustment) !== null) {
    return null;
  }

  const ops: OpInfo[] = [];
  for (const job of input.jobs) {
    job.operations.forEach((op, indexInJob) => {
      ops.push({
        id: op.id,
        jobId: job.id,
        indexInJob,
        machineType: op.machineType,
        duration: op.duration,
      });
    });
  }
  const opIndexById = new Map<string, number>();
  ops.forEach((op, i) => opIndexById.set(op.id, i));

  const currentByOpId = new Map<string, Placement>();
  for (const p of input.current) currentByOpId.set(p.operationId, p);

  const machineById = new Map<string, Machine>();
  for (const m of input.machines) machineById.set(m.id, m);

  const targetId = input.adjustment.operationId;

  // 每道工序的候选域。固定工序（锁定 + 目标）域为单点。
  const domains: Candidate[][] = ops.map((op) => {
    const cur = currentByOpId.get(op.id);
    if (!cur) return [];
    if (cur.locked) {
      return [{ machineId: cur.machineId, start: cur.start, changed: false, displacement: 0 }];
    }
    if (op.id === targetId) {
      return [
        {
          machineId: input.adjustment.machineId,
          start: input.adjustment.start,
          changed: false,
          displacement: 0,
        },
      ];
    }
    const candidates: Candidate[] = [];
    for (const machine of input.machines) {
      if (machine.type !== op.machineType) continue;
      for (const iv of machine.availability) {
        const lo = Math.max(iv.start, 0);
        const hi = Math.min(iv.end, PLANNING_WINDOW_SLOTS) - op.duration;
        for (let start = lo; start <= hi; start++) {
          const changed = machine.id !== cur.machineId || start !== cur.start;
          candidates.push({
            machineId: machine.id,
            start,
            changed,
            displacement: changed ? Math.abs(start - cur.start) : 0,
          });
        }
      }
    }
    candidates.sort((a, b) => {
      if (a.changed !== b.changed) return a.changed ? 1 : -1;
      return a.displacement - b.displacement;
    });
    return candidates;
  });

  if (domains.some((d) => d.length === 0)) return null;

  // 可移动工序：未锁定且非目标。按域大小升序排列以尽早剪枝。
  const movable: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const cur = currentByOpId.get(ops[i]!.id)!;
    if (!cur.locked && ops[i]!.id !== targetId) movable.push(i);
  }
  movable.sort((a, b) => domains[a]!.length - domains[b]!.length);

  // 已安排的固定工序。
  const assigned: (Candidate | null)[] = new Array<Candidate | null>(ops.length).fill(null);
  for (let i = 0; i < ops.length; i++) {
    if (domains[i]!.length === 1 && (currentByOpId.get(ops[i]!.id)!.locked || ops[i]!.id === targetId)) {
      assigned[i] = domains[i]![0]!;
    }
  }

  // 校验固定工序之间是否自洽（目标 vs 锁定）。
  for (let i = 0; i < ops.length; i++) {
    if (!assigned[i]) continue;
    for (let j = i + 1; j < ops.length; j++) {
      if (!assigned[j]) continue;
      if (!pairConsistent(ops[i]!, assigned[i]!, ops[j]!, assigned[j]!)) return null;
    }
  }

  const consistentWithAssigned = (opIdx: number, cand: Candidate): boolean => {
    for (let j = 0; j < ops.length; j++) {
      const other = assigned[j];
      if (j === opIdx || other == null) continue;
      if (!pairConsistent(ops[opIdx]!, cand, ops[j]!, other)) return false;
    }
    return true;
  };

  interface Best {
    changed: number;
    displacement: number;
    assign: (Candidate | null)[];
  }
  const bestRef: { value: Best | null } = { value: null };

  const dfs = (pos: number, changed: number, displacement: number): void => {
    const best = bestRef.value;
    if (best !== null) {
      if (changed > best.changed) return;
      if (changed === best.changed && displacement >= best.displacement) return;
    }
    if (pos === movable.length) {
      bestRef.value = { changed, displacement, assign: assigned.slice() };
      return;
    }
    const opIdx = movable[pos]!;
    for (const cand of domains[opIdx]!) {
      const nextChanged = changed + (cand.changed ? 1 : 0);
      const nextDisp = displacement + cand.displacement;
      const best = bestRef.value;
      if (best !== null) {
        if (nextChanged > best.changed) break; // 域已按代价排序
        if (nextChanged === best.changed && nextDisp >= best.displacement) break;
      }
      if (!consistentWithAssigned(opIdx, cand)) continue;
      assigned[opIdx] = cand;
      dfs(pos + 1, nextChanged, nextDisp);
      assigned[opIdx] = null;
    }
  };
  dfs(0, 0, 0);

  const best = bestRef.value;
  if (best === null) return null;

  const finalAssign = best.assign;
  const placements: Placement[] = ops.map((op, i) => {
    const cur = currentByOpId.get(op.id)!;
    const cand = finalAssign[i]!;
    return {
      operationId: op.id,
      machineId: cand.machineId,
      start: cand.start,
      locked: cur.locked,
    };
  });
  return { placements, changedCount: best.changed, totalDisplacement: best.displacement };
}

/** 两道工序的一对安排是否满足机器占用与先后依赖约束。 */
function pairConsistent(a: OpInfo, pa: Candidate, b: OpInfo, pb: Candidate): boolean {
  if (pa.machineId === pb.machineId) {
    const aEnd = pa.start + a.duration;
    const bEnd = pb.start + b.duration;
    if (pa.start < bEnd && pb.start < aEnd) return false;
  }
  if (a.jobId === b.jobId) {
    if (a.indexInJob < b.indexInJob && pb.start < pa.start + a.duration) return false;
    if (b.indexInJob < a.indexInJob && pa.start < pb.start + b.duration) return false;
  }
  return true;
}

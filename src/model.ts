import { HORIZON_SLOTS } from "./types.js";
import type { Job, Machine, Operation, Placement, Problem, Schedule } from "./types.js";

/** 工序在作业链中的位置。 */
export interface OpContext {
  op: Operation;
  job: Job;
  /** 在 job.operations 中的下标。 */
  index: number;
}

export interface ModelIndex {
  machinesById: Map<string, Machine>;
  opsById: Map<string, OpContext>;
  placementsByOpId: Map<string, Placement>;
}

export function buildIndex(problem: Problem, schedule: Schedule): ModelIndex {
  const machinesById = new Map<string, Machine>();
  for (const machine of problem.machines) machinesById.set(machine.id, machine);

  const opsById = new Map<string, OpContext>();
  for (const job of problem.jobs) {
    job.operations.forEach((op, index) => {
      opsById.set(op.id, { op, job, index });
    });
  }

  const placementsByOpId = new Map<string, Placement>();
  for (const placement of schedule.placements) {
    placementsByOpId.set(placement.opId, placement);
  }

  return { machinesById, opsById, placementsByOpId };
}

/** 两个半开区间是否相交。 */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 占用区间 [start, start+duration) 是否完整落在机器某个可用区间内。 */
export function fitsAvailability(
  machine: Machine,
  start: number,
  duration: number,
): boolean {
  const end = start + duration;
  return machine.available.some((iv) => iv.start <= start && end <= iv.end);
}

/** 占用区间是否落在规划窗口内。 */
export function fitsHorizon(start: number, duration: number): boolean {
  return start >= 0 && start + duration <= HORIZON_SLOTS;
}

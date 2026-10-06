import type {
  AdjustmentRequest,
  Problem,
  Schedule,
  SolveResult,
} from "./types.js";
import { solveAdjustment } from "./solver.js";

function cloneSchedule(schedule: Schedule): Schedule {
  return { placements: schedule.placements.map((p) => ({ ...p })) };
}

/**
 * 车间排程调整器。
 * 当前排程保存在内存中；预览不改变它，应用在无解时也保持它不变。
 */
export class Rescheduler {
  private current: Schedule;

  constructor(
    private readonly problem: Problem,
    initial: Schedule,
  ) {
    this.current = cloneSchedule(initial);
  }

  /** 当前排程的副本。 */
  getSchedule(): Schedule {
    return cloneSchedule(this.current);
  }

  /** 预览：返回候选排程，不改变当前排程。 */
  preview(request: AdjustmentRequest): SolveResult {
    return solveAdjustment(this.problem, this.current, request);
  }

  /** 应用：按相同规则整体替换当前排程；无解时当前排程保持不变。 */
  apply(request: AdjustmentRequest): SolveResult {
    const result = solveAdjustment(this.problem, this.current, request);
    if (result.ok) {
      this.current = cloneSchedule(result.schedule);
    }
    return result;
  }
}

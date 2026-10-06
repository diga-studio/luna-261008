import { solve, validateAdjustment } from "./solver.js";
import type {
  Adjustment,
  ApplyResult,
  Job,
  Machine,
  Placement,
  PreviewResult,
} from "./types.js";

/**
 * 车间排程调整器：当前排程保存在内存中，
 * 支持调整预览（不改变当前排程）与应用（整体替换当前排程）。
 */
export class WorkshopScheduler {
  readonly #machines: readonly Machine[];
  readonly #jobs: readonly Job[];
  #current: readonly Placement[];

  constructor(
    machines: readonly Machine[],
    jobs: readonly Job[],
    initialPlacements: readonly Placement[],
  ) {
    this.#machines = machines.map((m) => ({ ...m, availability: [...m.availability] }));
    this.#jobs = jobs.map((j) => ({ ...j, operations: [...j.operations] }));
    this.#current = initialPlacements.map((p) => ({ ...p }));
  }

  /** 当前排程（只读快照）。 */
  get placements(): readonly Placement[] {
    return this.#current;
  }

  /** 预览一次调整，返回候选排程，不改变当前排程。 */
  preview(adjustment: Adjustment): PreviewResult {
    const invalid = validateAdjustment(this.#machines, this.#jobs, this.#current, adjustment);
    if (invalid !== null) return { ok: false, reason: invalid };
    const output = solve({
      machines: this.#machines,
      jobs: this.#jobs,
      current: this.#current,
      adjustment,
    });
    if (output === null) return { ok: false, reason: "no feasible schedule" };
    return {
      ok: true,
      placements: output.placements,
      changedCount: output.changedCount,
      totalDisplacement: output.totalDisplacement,
    };
  }

  /** 应用一次调整：成功则整体替换当前排程，失败则保持不变。 */
  apply(adjustment: Adjustment): ApplyResult {
    const result = this.preview(adjustment);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.#current = result.placements;
    return {
      ok: true,
      placements: result.placements,
      changedCount: result.changedCount,
      totalDisplacement: result.totalDisplacement,
    };
  }
}

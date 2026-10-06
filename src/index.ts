import { computeUtilization } from "./calculator";
import { CheckinStore } from "./store";
import { CheckinSubmission, ZoneUtilization } from "./types";

export { CheckinStatus } from "./types";
export type { CheckinSubmission, ZoneUtilization } from "./types";

/**
 * 班次区域利用率核算库入口。
 * 签到数据保存在 SQLite 中；每次查询依据全部有效签到即时计算，
 * 因此新增签到或历史修订返回后，下一次查询立即体现变化。
 */
export class UtilizationLedger {
  private readonly store: CheckinStore;

  /** dbPath 为 SQLite 文件路径，传 ":memory:" 可纯内存运行。 */
  constructor(dbPath: string) {
    this.store = new CheckinStore(dbPath);
  }

  /** 提交签到或其修订；重复提交或较旧修订不影响解释结果。 */
  submitCheckin(submission: CheckinSubmission): void {
    this.store.submit(submission);
  }

  /**
   * 查询 [startMs, endMs) 内各区域累计占用时长（人·毫秒）与利用率。
   * 利用率 = 累计占用时长 / (区域容量 × 区间长度)，可超过 1，不截断。
   * 结果覆盖 capacities 中的全部区域。
   */
  queryUtilization(
    startMs: number,
    endMs: number,
    capacities: ReadonlyMap<string, number>,
  ): ZoneUtilization[] {
    return computeUtilization(this.store.allSubmissions(), startMs, endMs, capacities);
  }

  close(): void {
    this.store.close();
  }
}

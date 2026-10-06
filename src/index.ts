import { computeOccupiedMs } from "./engine.js";
import { CheckinStore } from "./store.js";
import type { CheckinEvent, ZoneUtilization } from "./types.js";

export * from "./types.js";
export { computeOccupiedMs } from "./engine.js";

/**
 * 班次区域利用率核算服务。签到保存在 SQLite 中，
 * 提交/修订后立即对后续查询可见。
 */
export class UtilizationService {
  private readonly store: CheckinStore;

  /**
   * @param dbPath SQLite 文件路径；传 ":memory:" 使用纯内存库。
   */
  constructor(dbPath: string) {
    this.store = new CheckinStore(dbPath);
  }

  /** 提交签到或其修订。重复提交与较旧修订自动忽略。 */
  submitCheckin(event: CheckinEvent): void {
    this.store.save(event);
  }

  /**
   * 查询 [startMs, endMs) 内各区域累计占用时长与利用率。
   * 每次查询都基于 SQLite 中的最新数据直接计算，修订立即生效。
   *
   * @param capacities 区域容量（正整数），统计期内固定。
   */
  getUtilization(
    startMs: number,
    endMs: number,
    capacities: Readonly<Record<string, number>>,
  ): ZoneUtilization[] {
    if (!(endMs > startMs)) {
      throw new RangeError("endMs must be greater than startMs");
    }
    for (const [zone, capacity] of Object.entries(capacities)) {
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new RangeError(`capacity for zone "${zone}" must be a positive integer`);
      }
    }
    const occupied = computeOccupiedMs(this.store.loadLatest(), startMs, endMs);
    const lengthMs = endMs - startMs;
    const zones = new Set<string>([...Object.keys(capacities), ...occupied.keys()]);
    return [...zones].sort().map((zone) => {
      const occupiedMs = occupied.get(zone) ?? 0;
      const capacity = capacities[zone] ?? 0;
      return {
        zone,
        occupiedMs,
        capacity,
        utilization: capacity > 0 ? occupiedMs / (capacity * lengthMs) : 0,
      };
    });
  }

  close(): void {
    this.store.close();
  }
}

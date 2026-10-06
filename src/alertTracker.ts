import {
  ACTIVE_WINDOW_SECONDS,
  ALERT_THRESHOLD,
  AlertChange,
  DownloadEvent,
  Interval,
} from "./types";

/**
 * 员工批量下载告警追踪器（单进程、内存态）。
 * 结果只取决于已接收事件的集合，与到达顺序和批次划分无关。
 *
 * 实现思路：状态仅为"每个员工、每个文件的下载时间戳集合"（对乱序不敏感）。
 * 每次批次后，对受影响的员工用扫描线重算其全部告警区间，
 * 再与批次前的区间做差集，得到净变化（新增/删除）。
 */
export class AlertTracker {
  /** 已处理的全局唯一 eventId。 */
  private readonly seenEventIds = new Set<string>();

  /** employeeId -> fileId -> 升序下载时间戳列表。 */
  private readonly downloads = new Map<string, Map<string, number[]>>();

  /** employeeId -> 当前告警区间缓存（与 downloads 保持一致）。 */
  private readonly alertsCache = new Map<string, Interval[]>();

  /** 接收一批下载事件，返回本批处理造成的告警净变化。 */
  ingest(events: DownloadEvent[]): AlertChange[] {
    const affected = new Set<string>();
    const before = new Map<string, Interval[]>();

    for (const event of events) {
      if (this.seenEventIds.has(event.eventId)) {
        continue;
      }
      this.seenEventIds.add(event.eventId);
      if (!affected.has(event.employeeId)) {
        affected.add(event.employeeId);
        before.set(event.employeeId, this.currentAlerts(event.employeeId));
      }
      this.record(event);
    }

    const changes: AlertChange[] = [];
    for (const employeeId of affected) {
      const oldIntervals = before.get(employeeId)!;
      const newIntervals = this.computeAlerts(employeeId);
      this.alertsCache.set(employeeId, newIntervals);
      const removed = oldIntervals.filter((iv) => !containsInterval(newIntervals, iv));
      const added = newIntervals.filter((iv) => !containsInterval(oldIntervals, iv));
      if (added.length > 0 || removed.length > 0) {
        changes.push({ employeeId, added, removed });
      }
    }
    return changes;
  }

  /** 返回该员工当前全部告警区间（极大、左闭右开、按起点升序）。 */
  getAlerts(employeeId: string): Interval[] {
    return this.currentAlerts(employeeId).map((iv) => ({ ...iv }));
  }

  private currentAlerts(employeeId: string): Interval[] {
    let cached = this.alertsCache.get(employeeId);
    if (cached === undefined) {
      cached = this.computeAlerts(employeeId);
      this.alertsCache.set(employeeId, cached);
    }
    return cached;
  }

  private record(event: DownloadEvent): void {
    let files = this.downloads.get(event.employeeId);
    if (files === undefined) {
      files = new Map();
      this.downloads.set(event.employeeId, files);
    }
    let timestamps = files.get(event.fileId);
    if (timestamps === undefined) {
      timestamps = [];
      files.set(event.fileId, timestamps);
    }
    insertSorted(timestamps, event.timestamp);
  }

  /**
   * 重算某员工的全部告警区间。
   * 先把每个文件的下载时间戳合并成活跃区间 [t, t+600)，
   * 再对所有文件的活跃区间做扫描线，统计任意时刻的活跃文件数。
   */
  private computeAlerts(employeeId: string): Interval[] {
    const files = this.downloads.get(employeeId);
    if (files === undefined) {
      return [];
    }

    const deltas = new Map<number, number>();
    for (const timestamps of files.values()) {
      for (const iv of mergeActiveIntervals(timestamps)) {
        deltas.set(iv.start, (deltas.get(iv.start) ?? 0) + 1);
        deltas.set(iv.end, (deltas.get(iv.end) ?? 0) - 1);
      }
    }

    const positions = [...deltas.keys()].sort((a, b) => a - b);
    const alerts: Interval[] = [];
    let activeFiles = 0;
    let alertStart: number | null = null;
    for (const pos of positions) {
      // 同一时刻的所有变化同时生效，先求和再判断。
      activeFiles += deltas.get(pos)!;
      if (alertStart === null && activeFiles >= ALERT_THRESHOLD) {
        alertStart = pos;
      } else if (alertStart !== null && activeFiles < ALERT_THRESHOLD) {
        alerts.push({ start: alertStart, end: pos });
        alertStart = null;
      }
    }
    return alerts;
  }
}

/** 把单个文件的下载时间戳（升序）合并成活跃区间 [t, t+600)。 */
function mergeActiveIntervals(timestamps: number[]): Interval[] {
  const merged: Interval[] = [];
  for (const t of timestamps) {
    const last = merged[merged.length - 1];
    if (last !== undefined && t <= last.end) {
      if (t + ACTIVE_WINDOW_SECONDS > last.end) {
        last.end = t + ACTIVE_WINDOW_SECONDS;
      }
    } else {
      merged.push({ start: t, end: t + ACTIVE_WINDOW_SECONDS });
    }
  }
  return merged;
}

function insertSorted(sorted: number[], value: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  sorted.splice(lo, 0, value);
}

function containsInterval(list: Interval[], target: Interval): boolean {
  return list.some((iv) => iv.start === target.start && iv.end === target.end);
}

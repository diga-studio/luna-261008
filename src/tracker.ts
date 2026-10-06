import type { AlertChange, DownloadEvent, Interval } from './types.js';

export const WINDOW_SECONDS = 600;
export const ALERT_THRESHOLD = 51;

interface EmployeeState {
  /** fileId -> download timestamps (insertion order; sorted on demand). */
  downloads: Map<string, number[]>;
  /** Cached maximal alert intervals, sorted by start. */
  alerts: Interval[];
}

function intervalKey(iv: Interval): string {
  return `${iv.start}:${iv.end}`;
}

/**
 * Merge one file's download timestamps into active intervals.
 * A download at t keeps the file active on [t, t + WINDOW_SECONDS);
 * overlapping or touching intervals merge into one.
 */
function fileActiveIntervals(timestamps: number[]): Interval[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const result: Interval[] = [];
  let start = sorted[0];
  let end = sorted[0] + WINDOW_SECONDS;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    if (t <= end) {
      end = Math.max(end, t + WINDOW_SECONDS);
    } else {
      result.push({ start, end });
      start = t;
      end = t + WINDOW_SECONDS;
    }
  }
  result.push({ start, end });
  return result;
}

/**
 * Sweep all files' active intervals and return the maximal half-open
 * intervals during which at least ALERT_THRESHOLD files are active.
 * Downloads and expiries at the same instant take effect together.
 */
function computeAlerts(downloads: Map<string, number[]>): Interval[] {
  const delta = new Map<number, number>();
  for (const timestamps of downloads.values()) {
    for (const iv of fileActiveIntervals(timestamps)) {
      delta.set(iv.start, (delta.get(iv.start) ?? 0) + 1);
      delta.set(iv.end, (delta.get(iv.end) ?? 0) - 1);
    }
  }
  const times = [...delta.keys()].sort((a, b) => a - b);
  const alerts: Interval[] = [];
  let count = 0;
  let openStart: number | null = null;
  for (const t of times) {
    count += delta.get(t)!;
    if (openStart === null && count >= ALERT_THRESHOLD) {
      openStart = t;
    } else if (openStart !== null && count < ALERT_THRESHOLD) {
      alerts.push({ start: openStart, end: t });
      openStart = null;
    }
  }
  return alerts;
}

function diffAlerts(employeeId: string, before: Interval[], after: Interval[]): AlertChange | null {
  const beforeKeys = new Set(before.map(intervalKey));
  const afterKeys = new Set(after.map(intervalKey));
  const removed = before.filter((iv) => !afterKeys.has(intervalKey(iv)));
  const added = after.filter((iv) => !beforeKeys.has(intervalKey(iv)));
  if (added.length === 0 && removed.length === 0) return null;
  return { employeeId, added, removed };
}

export class DownloadAlertTracker {
  private readonly seenEventIds = new Set<string>();
  private readonly employees = new Map<string, EmployeeState>();

  ingest(events: DownloadEvent[]): AlertChange[] {
    const affected = new Set<string>();
    for (const event of events) {
      if (this.seenEventIds.has(event.eventId)) continue;
      this.seenEventIds.add(event.eventId);
      let state = this.employees.get(event.employeeId);
      if (!state) {
        state = { downloads: new Map(), alerts: [] };
        this.employees.set(event.employeeId, state);
      }
      const list = state.downloads.get(event.fileId);
      if (list) list.push(event.timestamp);
      else state.downloads.set(event.fileId, [event.timestamp]);
      affected.add(event.employeeId);
    }

    const changes: AlertChange[] = [];
    for (const employeeId of affected) {
      const state = this.employees.get(employeeId)!;
      const next = computeAlerts(state.downloads);
      const change = diffAlerts(employeeId, state.alerts, next);
      state.alerts = next;
      if (change) changes.push(change);
    }
    return changes;
  }

  getAlerts(employeeId: string): Interval[] {
    const state = this.employees.get(employeeId);
    if (!state) return [];
    return state.alerts.map((iv) => ({ ...iv }));
  }
}

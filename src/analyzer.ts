import { ServiceWindow } from "./serviceData.js";
import { WINDOW_MS, type AnomalyInterval, type RequestRecord } from "./types.js";

function isError(statusCode: number): boolean {
  return statusCode >= 500 && statusCode <= 599;
}

/**
 * In-memory log error-rate alert analyzer.
 *
 * Tracks, per service, how many requests/errors fall into the 15 minute
 * sliding window (t - WINDOW_MS, t] at every moment, and reports the maximal
 * continuous intervals inside a query range where the error rate is strictly
 * above 5%. Appends may arrive in any order and deletions revise history;
 * every query reflects exactly the records present at that moment.
 *
 * Records are retained so traces can be deleted later; callers must not
 * mutate records after appending them.
 */
export class LogAlertAnalyzer {
  private readonly services = new Map<string, ServiceWindow>();
  private readonly serviceIds = new Map<string, number>();
  private readonly serviceNames: string[] = [];
  /** Flat record arena: timestamp of record i is recTimes[i]. */
  private readonly recTimes: number[] = [];
  /** recMeta[i] = (serviceId << 1) | isError for record i. */
  private readonly recMeta: number[] = [];
  /** traceId -> indices of its records in the arena. */
  private readonly traces = new Map<string, number[]>();

  private serviceId(service: string): number {
    let id = this.serviceIds.get(service);
    if (id === undefined) {
      id = this.serviceNames.length;
      this.serviceIds.set(service, id);
      this.serviceNames.push(service);
    }
    return id;
  }

  /** Append a batch of request records; records may arrive in any order. */
  append(records: ReadonlyArray<RequestRecord>): void {
    if (records.length === 0) return;
    const perService = new Map<number, number[]>();
    for (const record of records) {
      const err = isError(record.statusCode) ? 1 : 0;
      const sid = this.serviceId(record.service);
      let entries = perService.get(sid);
      if (entries === undefined) {
        entries = [];
        perService.set(sid, entries);
      }
      entries.push(record.timestampMs, 1, err, record.timestampMs + WINDOW_MS, -1, -err);

      const index = this.recTimes.length;
      this.recTimes.push(record.timestampMs);
      this.recMeta.push((sid << 1) | err);
      let stored = this.traces.get(record.traceId);
      if (stored === undefined) {
        stored = [];
        this.traces.set(record.traceId, stored);
      }
      stored.push(index);
    }
    for (const [sid, entries] of perService) {
      const service = this.serviceNames[sid]!;
      let window = this.services.get(service);
      if (window === undefined) {
        window = new ServiceWindow();
        this.services.set(service, window);
      }
      window.addDeltas(entries);
    }
  }

  /**
   * Delete every request belonging to the trace, across all services.
   * Returns the number of removed request records.
   */
  deleteByTraceId(traceId: string): number {
    const stored = this.traces.get(traceId);
    if (stored === undefined) return 0;
    this.traces.delete(traceId);
    const perService = new Map<number, number[]>();
    for (const index of stored) {
      const meta = this.recMeta[index]!;
      const sid = meta >> 1;
      const err = meta & 1;
      const ts = this.recTimes[index]!;
      let entries = perService.get(sid);
      if (entries === undefined) {
        entries = [];
        perService.set(sid, entries);
      }
      entries.push(ts, -1, -err, ts + WINDOW_MS, 1, err);
    }
    for (const [sid, entries] of perService) {
      this.services.get(this.serviceNames[sid]!)?.addDeltas(entries);
    }
    return stored.length;
  }

  /**
   * Maximal continuous anomalous intervals of one service within
   * [fromMs, toMs), clipped to the range and merged when adjacent.
   */
  queryAnomalyIntervals(service: string, fromMs: number, toMs: number): AnomalyInterval[] {
    const window = this.services.get(service);
    if (window === undefined) return [];
    return window.queryAnomalies(fromMs, toMs);
  }
}

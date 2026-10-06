import { WeightedIntervalMap } from "./treap";
import type { AnomalyInterval, RequestRecord } from "./types";

/** Sliding window length in milliseconds (15 minutes). */
export const WINDOW_MS = 900_000;

/**
 * A time t is anomalous when the window (t - WINDOW_MS, t] is non-empty
 * and errors / total > 0.05, i.e. 20 * errors - total > 0.
 * Weight +19 per error and -1 per success makes this exactly `sum > 0`:
 * 19e - s = 20e - (e + s) = 20 * errors - total. The empty window sums
 * to 0 (normal), and exactly 5% also sums to 0 (normal).
 */
const ERROR_WEIGHT = 19;
const SUCCESS_WEIGHT = -1;

function isErrorStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * In-memory error-rate alerting analyzer.
 *
 * Each request contributes its weight to the half-open interval
 * [timestampMs, timestampMs + WINDOW_MS) of its service's timeline:
 * it enters the window at its own timestamp and leaves WINDOW_MS later.
 * Anomalous points are exactly those with a strictly positive weight sum,
 * so queries reduce to reporting positive runs of the timeline.
 *
 * Records are stored in columnar typed arrays; each trace id maps to the
 * head of an intrusive linked list of its record slots, so deletion by
 * trace id never needs per-trace allocations.
 */
export class AlertAnalyzer {
  private readonly serviceIds = new Map<string, number>();
  private readonly timelines: WeightedIntervalMap[] = [];
  private readonly traceHead = new Map<string, number>();

  private timestamps = new Float64Array(1024);
  private weights = new Int8Array(1024);
  private recordService = new Int32Array(1024);
  private nextInTrace = new Int32Array(1024);
  private slots = 0;
  private live = 0;

  /** Number of currently stored request records. */
  get recordCount(): number {
    return this.live;
  }

  /** Appends a batch of request records (any order, any timestamps). */
  addRecords(batch: readonly RequestRecord[]): void {
    for (const record of batch) this.validate(record);
    this.ensureCapacity(this.slots + batch.length);
    for (const record of batch) {
      const weight = isErrorStatus(record.status) ? ERROR_WEIGHT : SUCCESS_WEIGHT;
      let serviceId = this.serviceIds.get(record.service);
      if (serviceId === undefined) {
        serviceId = this.serviceIds.size;
        this.serviceIds.set(record.service, serviceId);
        this.timelines.push(new WeightedIntervalMap());
      }
      const timeline = this.timelines[serviceId] as WeightedIntervalMap;
      timeline.addRange(record.timestampMs, record.timestampMs + WINDOW_MS, weight);
      const slot = this.slots;
      this.slots += 1;
      this.timestamps[slot] = record.timestampMs;
      this.weights[slot] = weight;
      this.recordService[slot] = serviceId;
      this.nextInTrace[slot] = this.traceHead.get(record.traceId) ?? -1;
      this.traceHead.set(record.traceId, slot);
      this.live += 1;
    }
  }

  /**
   * Removes every request with the given trace id across all services.
   * Returns the number of removed requests (0 when the trace is unknown).
   */
  deleteByTraceId(traceId: string): number {
    let slot = this.traceHead.get(traceId);
    if (slot === undefined) return 0;
    this.traceHead.delete(traceId);
    let removed = 0;
    while (slot !== -1) {
      const timestampMs = this.timestamps[slot] as number;
      const serviceId = this.recordService[slot] as number;
      const timeline = this.timelines[serviceId] as WeightedIntervalMap;
      timeline.addRange(timestampMs, timestampMs + WINDOW_MS, -(this.weights[slot] as number));
      slot = this.nextInTrace[slot] as number;
      removed += 1;
    }
    this.live -= removed;
    return removed;
  }

  /**
   * Returns the maximal anomalous intervals of a service inside the
   * half-open range [startMs, endMs), clipped to the range, merged when
   * adjacent, with millisecond precision.
   */
  queryAnomalyIntervals(service: string, startMs: number, endMs: number): AnomalyInterval[] {
    if (endMs <= startMs) return [];
    const serviceId = this.serviceIds.get(service);
    if (serviceId === undefined) return [];
    const timeline = this.timelines[serviceId] as WeightedIntervalMap;
    return timeline.positiveIntervals(startMs, endMs);
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.timestamps.length) return;
    let capacity = this.timestamps.length;
    while (capacity < needed) capacity *= 2;
    const timestamps = new Float64Array(capacity);
    timestamps.set(this.timestamps);
    this.timestamps = timestamps;
    const weights = new Int8Array(capacity);
    weights.set(this.weights);
    this.weights = weights;
    const recordService = new Int32Array(capacity);
    recordService.set(this.recordService);
    this.recordService = recordService;
    const nextInTrace = new Int32Array(capacity);
    nextInTrace.set(this.nextInTrace);
    this.nextInTrace = nextInTrace;
  }

  private validate(record: RequestRecord): void {
    if (record === null || typeof record !== "object") {
      throw new TypeError("record must be an object");
    }
    if (!Number.isFinite(record.timestampMs)) {
      throw new RangeError("timestampMs must be a finite number");
    }
    if (typeof record.service !== "string" || record.service.length === 0) {
      throw new TypeError("service must be a non-empty string");
    }
    if (!Number.isInteger(record.status) || record.status < 100 || record.status > 999) {
      throw new RangeError("status must be an integer HTTP status code");
    }
    if (typeof record.traceId !== "string" || record.traceId.length === 0) {
      throw new TypeError("traceId must be a non-empty string");
    }
  }
}

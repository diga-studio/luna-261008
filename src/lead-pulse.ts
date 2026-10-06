import type {
  BehaviorEvent,
  EventType,
  ScoreResult,
  ScoreBreakdown,
  TypeBreakdown,
  Weights,
} from "./types.js";
import { EVENT_TYPES } from "./types.js";
import { DAY_MS, FULL_WINDOW_MS, MID_WINDOW_MS, companyScore } from "./decay.js";

export const DEFAULT_WEIGHTS: Weights = {
  pricing_view: 15,
  whitepaper_download: 10,
  webinar_attend: 20,
  demo_request: 30,
};

const PENDING_FLUSH_THRESHOLD = 256;

interface TypeBucket {
  sorted: number[];
  pending: number[];
}

interface LeadRecord {
  companySize: number;
  buckets: Record<EventType, TypeBucket>;
}

function createBuckets(): Record<EventType, TypeBucket> {
  return {
    pricing_view: { sorted: [], pending: [] },
    whitepaper_download: { sorted: [], pending: [] },
    webinar_attend: { sorted: [], pending: [] },
    demo_request: { sorted: [], pending: [] },
  };
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function flushBucket(bucket: TypeBucket): void {
  const pending = bucket.pending;
  if (pending.length === 0) return;
  pending.sort((a, b) => a - b);
  const sorted = bucket.sorted;
  if (sorted.length === 0) {
    bucket.sorted = pending;
    bucket.pending = [];
    return;
  }
  const merged = new Array<number>(sorted.length + pending.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < sorted.length && j < pending.length) {
    if (sorted[i]! <= pending[j]!) merged[k++] = sorted[i++]!;
    else merged[k++] = pending[j++]!;
  }
  while (i < sorted.length) merged[k++] = sorted[i++]!;
  while (j < pending.length) merged[k++] = pending[j++]!;
  bucket.sorted = merged;
  bucket.pending = [];
}

export class LeadPulse {
  private readonly leads = new Map<string, LeadRecord>();
  private readonly seenEventIds = new Set<string>();
  private weights: Weights = { ...DEFAULT_WEIGHTS };

  constructor() {
  }

  registerLead(leadId: string, companySize: number): void {
    if (typeof leadId !== "string" || leadId.length === 0) {
      throw new Error("leadId must be a non-empty string");
    }
    if (!Number.isFinite(companySize)) {
      throw new Error("companySize must be a finite number");
    }
    if (this.leads.has(leadId)) {
      throw new Error(`lead already registered: ${leadId}`);
    }
    this.leads.set(leadId, { companySize, buckets: createBuckets() });
  }

  ingestEvent(event: BehaviorEvent): boolean {
    if (event === null || typeof event !== "object") {
      throw new Error("event must be an object");
    }
    const { id, leadId, type, occurredAt } = event;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("event.id must be a non-empty string");
    }
    if (!LeadPulse.isEventType(type)) {
      throw new Error(`unknown event type: ${String(type)}`);
    }
    if (!Number.isFinite(occurredAt)) {
      throw new Error("event.occurredAt must be a finite number (unix ms)");
    }
    const lead = this.leads.get(leadId);
    if (lead === undefined) {
      throw new Error(`unknown lead: ${String(leadId)}`);
    }
    if (this.seenEventIds.has(id)) {
      return false;
    }
    this.seenEventIds.add(id);
    const bucket = lead.buckets[type];
    bucket.pending.push(occurredAt);
    if (bucket.pending.length >= PENDING_FLUSH_THRESHOLD) {
      flushBucket(bucket);
    }
    return true;
  }

  setWeights(weights: Partial<Weights>): void {
    if (weights === null || typeof weights !== "object") {
      throw new Error("weights must be an object");
    }
    for (const key of Object.keys(weights)) {
      if (!LeadPulse.isEventType(key)) {
        throw new Error(`unknown weight key: ${key}`);
      }
      const value = weights[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error(`weight for ${key} must be an integer in [0, 100]`);
      }
      this.weights[key] = value;
    }
  }

  getWeights(): Weights {
    return { ...this.weights };
  }

  scoreAt(leadId: string, queryAt: number): ScoreResult {
    if (!Number.isFinite(queryAt)) {
      throw new Error("queryAt must be a finite number (unix ms)");
    }
    const lead = this.leads.get(leadId);
    if (lead === undefined) {
      throw new Error(`unknown lead: ${leadId}`);
    }
    const fullBoundary = queryAt - FULL_WINDOW_MS;
    const midBoundary = queryAt - MID_WINDOW_MS;
    const breakdown = {} as Record<EventType, TypeBreakdown>;
    let behaviorHundredths = 0;
    for (const type of EVENT_TYPES) {
      const bucket = lead.buckets[type];
      flushBucket(bucket);
      const arr = bucket.sorted;
      const fullStart = lowerBound(arr, fullBoundary);
      const midStart = lowerBound(arr, midBoundary);
      const eligibleEnd = upperBound(arr, queryAt);
      const within30Count = eligibleEnd - fullStart;
      const midCount = fullStart - midStart;
      const oldCount = midStart;
      const weight = this.weights[type];
      const within30Hundredths = within30Count * weight * 100;
      const midHundredths = midCount * weight * 75;
      const oldHundredths = oldCount * weight * 40;
      const typeHundredths =
        within30Hundredths + midHundredths + oldHundredths;
      behaviorHundredths += typeHundredths;
      breakdown[type] = {
        within30d: {
          count: within30Count,
          contribution: within30Hundredths / 100,
        },
        between30And90d: {
          count: midCount,
          contribution: midHundredths / 100,
        },
        over90d: {
          count: oldCount,
          contribution: oldHundredths / 100,
        },
        contribution: typeHundredths / 100,
      };
    }
    const company = companyScore(lead.companySize);
    const totalHundredths = company * 100 + behaviorHundredths;
    const totalScore = totalHundredths / 100;
    const score = Math.min(100, Math.max(0, totalScore));
    return {
      leadId,
      queryAt,
      companyScore: company,
      behaviorScore: behaviorHundredths / 100,
      totalScore,
      score,
      breakdown: breakdown as ScoreBreakdown,
    };
  }

  static readonly eventTypes = EVENT_TYPES;

  static isEventType(value: unknown): value is EventType {
    return (
      typeof value === "string" &&
      (EVENT_TYPES as readonly string[]).includes(value)
    );
  }
}

export { DAY_MS };

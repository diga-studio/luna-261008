import {
  SECONDS_PER_DAY,
  type CheckIn,
  type ConfidenceRecord,
  type KeyResultSpec,
  type ObjectiveSpec,
  type OkrHistory,
} from "./types.js";

export const DEFAULT_CONFIDENCE = 5.5;
export const MIN_PERIOD_DAYS = 28;
export const WINDOW_DAYS = 28;
export const FREQUENCY_SLOTS = 4;

/** First index i in sorted `arr` with arr[i] >= x. */
export function lowerBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in sorted `arr` with arr[i] > x. */
export function upperBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeCheckInValue(spec: KeyResultSpec, value: number): number {
  let raw: number;
  switch (spec.progressKind) {
    case "percentage":
      raw = value / 100;
      break;
    case "numeric":
      raw = value / spec.targetValue!;
      break;
    case "binary":
      raw = value;
      break;
  }
  return clamp01(raw);
}

/**
 * Per-KR prepared history.
 *
 * Confidence is a last-value-held step curve: DEFAULT_CONFIDENCE before the
 * first record, confValues[i] on [confTimes[i], confTimes[i+1]).
 * confCumCt[i] / confCumCtt[i] are the integrals of c(t) and c(t)*t over
 * [confTimes[0], confTimes[i]) with t measured in days, so the window
 * integrals for any [L, T] are differences of an antiderivative evaluated
 * by binary search plus a partial-segment term.
 */
export interface PreparedKeyResult {
  readonly id: string;
  readonly weight: number;
  readonly checkInTimes: Float64Array;
  readonly checkInProgress: Float64Array;
  readonly confTimes: Float64Array;
  readonly confValues: Float64Array;
  readonly confCumCt: Float64Array;
  readonly confCumCtt: Float64Array;
}

export interface PreparedObjective {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly periodDays: number;
  readonly krs: readonly PreparedKeyResult[];
}

export interface PreparedHistory {
  readonly objectives: ReadonlyMap<string, PreparedObjective>;
}

function validateObjective(spec: ObjectiveSpec): void {
  if (spec.krs.length < 1 || spec.krs.length > 5) {
    throw new Error(`objective ${spec.id}: expected 1..5 key results, got ${spec.krs.length}`);
  }
  if (spec.end - spec.start < MIN_PERIOD_DAYS * SECONDS_PER_DAY) {
    throw new Error(`objective ${spec.id}: period must be at least ${MIN_PERIOD_DAYS} days`);
  }
  let weightSum = 0;
  const seen = new Set<string>();
  for (const kr of spec.krs) {
    if (seen.has(kr.id)) {
      throw new Error(`objective ${spec.id}: duplicate key result id ${kr.id}`);
    }
    seen.add(kr.id);
    weightSum += kr.weight;
    if (kr.progressKind === "numeric") {
      if (typeof kr.targetValue !== "number" || !(kr.targetValue > 0)) {
        throw new Error(`key result ${kr.id}: numeric progress requires a positive targetValue`);
      }
    }
  }
  if (Math.abs(weightSum - 100) > 1e-9) {
    throw new Error(`objective ${spec.id}: key result weights must sum to 100, got ${weightSum}`);
  }
}

function prepareKeyResult(
  spec: KeyResultSpec,
  checkIns: readonly CheckIn[],
  confRecords: readonly ConfidenceRecord[],
): PreparedKeyResult {
  const sortedCheckIns = checkIns.slice().sort((a, b) => a.time - b.time);
  const checkInTimes = new Float64Array(sortedCheckIns.length);
  const checkInProgress = new Float64Array(sortedCheckIns.length);
  for (let i = 0; i < sortedCheckIns.length; i++) {
    const c = sortedCheckIns[i]!;
    checkInTimes[i] = c.time;
    checkInProgress[i] = normalizeCheckInValue(spec, c.value);
  }

  const sortedConf = confRecords.slice().sort((a, b) => a.time - b.time);
  const n = sortedConf.length;
  const confTimes = new Float64Array(n);
  const confValues = new Float64Array(n);
  const confCumCt = new Float64Array(n);
  const confCumCtt = new Float64Array(n);
  let compCt = 0;
  let compCtt = 0;
  for (let i = 0; i < n; i++) {
    const r = sortedConf[i]!;
    if (!Number.isInteger(r.confidence) || r.confidence < 1 || r.confidence > 10) {
      throw new Error(`key result ${spec.id}: confidence must be an integer in [1, 10], got ${r.confidence}`);
    }
    confTimes[i] = r.time;
    confValues[i] = r.confidence;
    if (i > 0) {
      const prevDays = confTimes[i - 1]! / SECONDS_PER_DAY;
      const curDays = r.time / SECONDS_PER_DAY;
      const held = confValues[i - 1]!;
      // Kahan-compensated prefix sums: over 20 years of dense records the
      // running totals reach ~1e9 point-days^2, and naive accumulation
      // would drift far beyond the 1e-8 accuracy budget.
      const addCt = held * (curDays - prevDays);
      const adjCt = addCt - compCt;
      const nextCt = confCumCt[i - 1]! + adjCt;
      compCt = (nextCt - confCumCt[i - 1]!) - adjCt;
      confCumCt[i] = nextCt;
      const addCtt = (held * (curDays * curDays - prevDays * prevDays)) / 2;
      const adjCtt = addCtt - compCtt;
      const nextCtt = confCumCtt[i - 1]! + adjCtt;
      compCtt = (nextCtt - confCumCtt[i - 1]!) - adjCtt;
      confCumCtt[i] = nextCtt;
    }
  }

  return {
    id: spec.id,
    weight: spec.weight,
    checkInTimes,
    checkInProgress,
    confTimes,
    confValues,
    confCumCt,
    confCumCtt,
  };
}

export function prepareHistory(history: OkrHistory): PreparedHistory {
  const checkInsByKr = new Map<string, CheckIn[]>();
  for (const c of history.checkIns) {
    let list = checkInsByKr.get(c.krId);
    if (!list) checkInsByKr.set(c.krId, (list = []));
    list.push(c);
  }
  const confByKr = new Map<string, ConfidenceRecord[]>();
  for (const r of history.confidenceRecords) {
    let list = confByKr.get(r.krId);
    if (!list) confByKr.set(r.krId, (list = []));
    list.push(r);
  }

  const objectives = new Map<string, PreparedObjective>();
  for (const spec of history.objectives) {
    if (objectives.has(spec.id)) {
      throw new Error(`duplicate objective id ${spec.id}`);
    }
    validateObjective(spec);
    const krs = spec.krs.map((kr) =>
      prepareKeyResult(kr, checkInsByKr.get(kr.id) ?? [], confByKr.get(kr.id) ?? []),
    );
    objectives.set(spec.id, {
      id: spec.id,
      start: spec.start,
      end: spec.end,
      periodDays: (spec.end - spec.start) / SECONDS_PER_DAY,
      krs,
    });
  }
  return { objectives };
}

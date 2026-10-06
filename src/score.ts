import {
  DEFAULT_CONFIDENCE,
  FREQUENCY_SLOTS,
  MIN_PERIOD_DAYS,
  WINDOW_DAYS,
  clamp01,
  lowerBound,
  upperBound,
  type PreparedKeyResult,
  type PreparedObjective,
} from "./prepare.js";
import {
  SECONDS_PER_DAY,
  type HealthScore,
  type KeyResultHealth,
  type ObjectiveHealth,
} from "./types.js";

const SLOT_SECONDS = (WINDOW_DAYS / FREQUENCY_SLOTS) * SECONDS_PER_DAY;

/** Last-value-held progress at time t; 0 before the first check-in. */
export function progressAt(kr: PreparedKeyResult, t: number): number {
  const i = upperBound(kr.checkInTimes, t) - 1;
  return i < 0 ? 0 : kr.checkInProgress[i]!;
}

/**
 * Antiderivative of the held-confidence curve c(t): integral of c over
 * [confTimes[0], t] in point-days (origin at the first record, or at the
 * epoch when there are no records). Differences give window integrals.
 */
function confIntegralCt(kr: PreparedKeyResult, tSeconds: number): number {
  const tDays = tSeconds / SECONDS_PER_DAY;
  const n = kr.confTimes.length;
  if (n === 0) return DEFAULT_CONFIDENCE * tDays;
  const i = upperBound(kr.confTimes, tSeconds) - 1;
  const t0Days = kr.confTimes[0]! / SECONDS_PER_DAY;
  if (i < 0) return DEFAULT_CONFIDENCE * (tDays - t0Days);
  const tiDays = kr.confTimes[i]! / SECONDS_PER_DAY;
  return kr.confCumCt[i]! + kr.confValues[i]! * (tDays - tiDays);
}

/** Antiderivative of c(t)*t, t in days. */
function confIntegralCtt(kr: PreparedKeyResult, tSeconds: number): number {
  const tDays = tSeconds / SECONDS_PER_DAY;
  const n = kr.confTimes.length;
  if (n === 0) return DEFAULT_CONFIDENCE * (tDays * tDays) / 2;
  const i = upperBound(kr.confTimes, tSeconds) - 1;
  const t0Days = kr.confTimes[0]! / SECONDS_PER_DAY;
  if (i < 0) return DEFAULT_CONFIDENCE * (tDays * tDays - t0Days * t0Days) / 2;
  const tiDays = kr.confTimes[i]! / SECONDS_PER_DAY;
  return kr.confCumCtt[i]! + kr.confValues[i]! * (tDays * tDays - tiDays * tiDays) / 2;
}

/** Velocity: progress gained over the window, scaled to the 28-day norm. */
function velocityScore(kr: PreparedKeyResult, periodDays: number, L: number, T: number): number {
  const gained = progressAt(kr, T) - progressAt(kr, L);
  return clamp01((gained * periodDays) / WINDOW_DAYS);
}

/** Frequency: share of the four 7-day slots containing at least one check-in. */
function frequencyScore(kr: PreparedKeyResult, L: number): number {
  let occupied = 0;
  for (let slot = 0; slot < FREQUENCY_SLOTS; slot++) {
    const slotStart = L + slot * SLOT_SECONDS;
    const slotEnd = slotStart + SLOT_SECONDS;
    if (lowerBound(kr.checkInTimes, slotStart) < lowerBound(kr.checkInTimes, slotEnd)) {
      occupied++;
    }
  }
  return occupied / FREQUENCY_SLOTS;
}

/**
 * Trend: continuous-time least-squares slope b (points/day) of the
 * held-confidence curve over the window, mapped to 0.5 + 28b/18.
 * Integrals are taken with the origin shifted to L for numerical stability;
 * the slope is invariant under that shift.
 */
function trendScore(kr: PreparedKeyResult, L: number, T: number): number {
  const lDays = L / SECONDS_PER_DAY;
  const durationDays = (T - L) / SECONDS_PER_DAY;

  const j0 = confIntegralCt(kr, T) - confIntegralCt(kr, L);
  const j1 = confIntegralCtt(kr, T) - confIntegralCtt(kr, L) - lDays * j0;

  const i0 = durationDays;
  const i1 = (durationDays * durationDays) / 2;
  const i2 = (durationDays * durationDays * durationDays) / 3;

  const denominator = i0 * i2 - i1 * i1;
  const slope = (i0 * j1 - i1 * j0) / denominator;
  return clamp01(0.5 + (WINDOW_DAYS * slope) / 18);
}

export function scoreKeyResult(
  kr: PreparedKeyResult,
  periodDays: number,
  L: number,
  T: number,
): HealthScore {
  const velocity = velocityScore(kr, periodDays, L, T);
  const frequency = frequencyScore(kr, L);
  const trend = trendScore(kr, L, T);
  return {
    velocity,
    frequency,
    trend,
    health: 0.4 * velocity + 0.3 * frequency + 0.3 * trend,
  };
}

export function scorePreparedObjective(obj: PreparedObjective, T: number): ObjectiveHealth {
  const earliest = obj.start + MIN_PERIOD_DAYS * SECONDS_PER_DAY;
  if (T < earliest || T > obj.end) {
    throw new Error(
      `objective ${obj.id}: query time ${T} outside [${earliest}, ${obj.end}]`,
    );
  }
  const L = T - WINDOW_DAYS * SECONDS_PER_DAY;

  let velocity = 0;
  let frequency = 0;
  let trend = 0;
  let health = 0;
  const krs: KeyResultHealth[] = [];
  for (const kr of obj.krs) {
    const score = scoreKeyResult(kr, obj.periodDays, L, T);
    const w = kr.weight / 100;
    velocity += w * score.velocity;
    frequency += w * score.frequency;
    trend += w * score.trend;
    health += w * score.health;
    krs.push({ krId: kr.id, weight: kr.weight, ...score });
  }
  return { objectiveId: obj.id, time: T, velocity, frequency, trend, health, krs };
}

/**
 * Independent reference implementation used only by tests.
 *
 * Deliberately naive: every query scans the raw records and integrates
 * the confidence step curve segment by segment. Shares no code with the
 * engine under test.
 */
import type {
  CheckIn,
  ConfidenceReview,
  HealthScore,
  KrSpec,
  ObjectiveSpec,
} from '../src/index.js';
import {
  SECONDS_PER_DAY,
  WINDOW_SECONDS,
  WINDOW_DAYS,
  FREQUENCY_BUCKETS,
  BUCKET_SECONDS,
  DEFAULT_CONFIDENCE,
} from '../src/index.js';

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normalize(spec: KrSpec, raw: number): number {
  switch (spec.progressKind) {
    case 'percent':
      return clamp01(raw / 100);
    case 'number':
      return clamp01(raw / spec.targetValue!);
    case 'binary':
      return clamp01(raw);
  }
}

function progressAt(
  spec: KrSpec,
  checkIns: readonly CheckIn[],
  t: number,
): number {
  let bestTime = -Infinity;
  let value = 0;
  for (const c of checkIns) {
    if (c.krId === spec.id && c.time <= t && c.time >= bestTime) {
      bestTime = c.time;
      value = normalize(spec, c.value);
    }
  }
  return value;
}

export function referenceKrScore(
  spec: KrSpec,
  objective: ObjectiveSpec,
  checkIns: readonly CheckIn[],
  reviews: readonly ConfidenceReview[],
  T: number,
): HealthScore {
  const L = T - WINDOW_SECONDS;
  const cycleDays = (objective.end - objective.start) / SECONDS_PER_DAY;

  const velocity = clamp01(
    ((progressAt(spec, checkIns, T) - progressAt(spec, checkIns, L)) *
      cycleDays) /
      WINDOW_DAYS,
  );

  let hits = 0;
  for (let k = 0; k < FREQUENCY_BUCKETS; k++) {
    const lo = L + k * BUCKET_SECONDS;
    const hi = lo + BUCKET_SECONDS;
    if (checkIns.some((c) => c.krId === spec.id && c.time >= lo && c.time < hi)) {
      hits++;
    }
  }
  const frequency = hits / FREQUENCY_BUCKETS;

  // Segment-by-segment continuous-time least squares over [L, T].
  const events = reviews
    .filter((r) => r.krId === spec.id && r.time <= T)
    .sort((a, b) => a.time - b.time);
  let m0 = 0;
  let m1 = 0;
  let cursor = L;
  let value = DEFAULT_CONFIDENCE;
  for (const e of events) {
    if (e.time <= L) {
      value = e.score;
      continue;
    }
    const segEnd = Math.min(e.time, T);
    if (segEnd > cursor) {
      m0 += value * (segEnd - cursor);
      const a = cursor - L;
      const b = segEnd - L;
      m1 += (value * (b * b - a * a)) / 2;
    }
    cursor = e.time;
    value = e.score;
  }
  if (T > cursor) {
    m0 += value * (T - cursor);
    const a = cursor - L;
    const b = T - L;
    m1 += (value * (b * b - a * a)) / 2;
  }
  const slopePerSecond =
    ((m1 - (m0 * WINDOW_SECONDS) / 2) * 12) /
    (WINDOW_SECONDS * WINDOW_SECONDS * WINDOW_SECONDS);
  const trend = clamp01(
    0.5 + (WINDOW_DAYS * slopePerSecond * SECONDS_PER_DAY) / 18,
  );

  return {
    velocity,
    frequency,
    trend,
    health: 0.4 * velocity + 0.3 * frequency + 0.3 * trend,
  };
}

export function referenceObjectiveScore(
  krs: readonly KrSpec[],
  objective: ObjectiveSpec,
  checkIns: readonly CheckIn[],
  reviews: readonly ConfidenceReview[],
  T: number,
): HealthScore {
  let velocity = 0;
  let frequency = 0;
  let trend = 0;
  for (const kr of krs) {
    const s = referenceKrScore(kr, objective, checkIns, reviews, T);
    const w = kr.weight / 100;
    velocity += w * s.velocity;
    frequency += w * s.frequency;
    trend += w * s.trend;
  }
  return {
    velocity,
    frequency,
    trend,
    health: 0.4 * velocity + 0.3 * frequency + 0.3 * trend,
  };
}

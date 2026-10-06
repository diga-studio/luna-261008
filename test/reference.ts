/**
 * Independent reference implementation used only by tests. It recomputes
 * every query segment by segment directly from the raw history, sharing no
 * code with the library under test: no prefix integrals, no antiderivative
 * trick — the window is walked record by record and each least-squares
 * integral is accumulated with the origin at the window start.
 */
import {
  SECONDS_PER_DAY,
  type HealthScore,
  type KeyResultSpec,
  type ObjectiveSpec,
  type OkrHistory,
} from "../src/index.js";

const DAY = SECONDS_PER_DAY;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normalize(spec: KeyResultSpec, value: number): number {
  if (spec.progressKind === "percentage") return clamp01(value / 100);
  if (spec.progressKind === "numeric") return clamp01(value / spec.targetValue!);
  return clamp01(value);
}

interface KrRecords {
  checkInTimes: number[];
  checkInValues: number[];
  confTimes: number[];
  confValues: number[];
}

/** Index of the last element <= t, or -1. */
function lastLeq(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export class ReferenceScorer {
  readonly #objectives: ReadonlyMap<string, ObjectiveSpec>;
  readonly #krSpecs: ReadonlyMap<string, KeyResultSpec>;
  readonly #records: ReadonlyMap<string, KrRecords>;

  constructor(history: OkrHistory) {
    const objectives = new Map<string, ObjectiveSpec>();
    const krSpecs = new Map<string, KeyResultSpec>();
    for (const obj of history.objectives) {
      objectives.set(obj.id, obj);
      for (const kr of obj.krs) krSpecs.set(kr.id, kr);
    }
    this.#objectives = objectives;
    this.#krSpecs = krSpecs;

    const records = new Map<string, KrRecords>();
    const ensure = (krId: string): KrRecords => {
      let r = records.get(krId);
      if (!r) {
        r = { checkInTimes: [], checkInValues: [], confTimes: [], confValues: [] };
        records.set(krId, r);
      }
      return r;
    };
    for (const c of history.checkIns) {
      const spec = krSpecs.get(c.krId);
      if (!spec) continue;
      const r = ensure(c.krId);
      r.checkInTimes.push(c.time);
      r.checkInValues.push(normalize(spec, c.value));
    }
    for (const c of history.confidenceRecords) {
      const r = ensure(c.krId);
      r.confTimes.push(c.time);
      r.confValues.push(c.confidence);
    }
    for (const r of records.values()) {
      const ci = r.checkInTimes.map((t, i) => [t, r.checkInValues[i]!] as const);
      ci.sort((a, b) => a[0] - b[0]);
      r.checkInTimes = ci.map((p) => p[0]);
      r.checkInValues = ci.map((p) => p[1]);
      const cf = r.confTimes.map((t, i) => [t, r.confValues[i]!] as const);
      cf.sort((a, b) => a[0] - b[0]);
      r.confTimes = cf.map((p) => p[0]);
      r.confValues = cf.map((p) => p[1]);
    }
    this.#records = records;
  }

  #progressAt(krId: string, t: number): number {
    const r = this.#records.get(krId);
    if (!r) return 0;
    const i = lastLeq(r.checkInTimes, t);
    return i < 0 ? 0 : r.checkInValues[i]!;
  }

  #confidenceAt(krId: string, t: number): number {
    const r = this.#records.get(krId);
    if (!r) return 5.5;
    const i = lastLeq(r.confTimes, t);
    return i < 0 ? 5.5 : r.confValues[i]!;
  }

  #frequency(krId: string, L: number): number {
    const r = this.#records.get(krId);
    if (!r) return 0;
    let occupied = 0;
    for (let slot = 0; slot < 4; slot++) {
      const slotStart = L + slot * 7 * DAY;
      const slotEnd = slotStart + 7 * DAY;
      for (let i = 0; i < r.checkInTimes.length; i++) {
        const t = r.checkInTimes[i]!;
        if (t >= slotEnd) break;
        if (t >= slotStart) {
          occupied++;
          break;
        }
      }
    }
    return occupied / 4;
  }

  /** Segment-by-segment continuous least-squares trend over [L, T]. */
  #trend(krId: string, L: number, T: number): number {
    const r = this.#records.get(krId);
    let j0 = 0;
    let j1 = 0;
    let cursor = L;
    let value = this.#confidenceAt(krId, L);
    if (r) {
      // Walk every record inside the window in order.
      let i = lastLeq(r.confTimes, L) + 1;
      while (i < r.confTimes.length && r.confTimes[i]! < T) {
        const next = r.confTimes[i]!;
        const a = (cursor - L) / DAY;
        const b = (next - L) / DAY;
        j0 += value * (b - a);
        j1 += (value * (b * b - a * a)) / 2;
        cursor = next;
        value = r.confValues[i]!;
        i++;
      }
    }
    const a = (cursor - L) / DAY;
    const b = (T - L) / DAY;
    j0 += value * (b - a);
    j1 += (value * (b * b - a * a)) / 2;

    const duration = (T - L) / DAY;
    const i0 = duration;
    const i1 = (duration * duration) / 2;
    const i2 = (duration * duration * duration) / 3;
    const slope = (i0 * j1 - i1 * j0) / (i0 * i2 - i1 * i1);
    return clamp01(0.5 + (28 * slope) / 18);
  }

  scoreKeyResult(objective: ObjectiveSpec, kr: KeyResultSpec, T: number): HealthScore {
    const L = T - 28 * DAY;
    const periodDays = (objective.end - objective.start) / DAY;
    const velocity = clamp01(
      ((this.#progressAt(kr.id, T) - this.#progressAt(kr.id, L)) * periodDays) / 28,
    );
    const frequency = this.#frequency(kr.id, L);
    const trend = this.#trend(kr.id, L, T);
    return {
      velocity,
      frequency,
      trend,
      health: 0.4 * velocity + 0.3 * frequency + 0.3 * trend,
    };
  }

  scoreObjective(objectiveId: string, T: number): HealthScore {
    const objective = this.#objectives.get(objectiveId)!;
    let velocity = 0;
    let frequency = 0;
    let trend = 0;
    let health = 0;
    for (const kr of objective.krs) {
      const s = this.scoreKeyResult(objective, kr, T);
      const w = kr.weight / 100;
      velocity += w * s.velocity;
      frequency += w * s.frequency;
      trend += w * s.trend;
      health += w * s.health;
    }
    return { velocity, frequency, trend, health };
  }
}

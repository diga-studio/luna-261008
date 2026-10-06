import {
  SEGMENT_COUNT,
  SETS_PER_SEGMENT,
  SETS_PER_EXERCISE,
  INITIAL_LOAD_LBS,
  INCREMENT_LBS,
  TARGET_REPS,
  SetRecord,
} from './types.js';

/**
 * Derive the recommended-load curve (26 segments) for one exercise from its
 * 468 set slots in chronological order (week, session, setIndex); null means
 * "no record". Segment 0 recommends 40 lbs. A later segment increases by
 * 5 lbs over the previous recommendation only when every one of the previous
 * segment's 18 sets has a record with reps >= 10 and actual weight >= the
 * previous recommendation; otherwise the recommendation is carried over.
 */
export function deriveExerciseCurve(sets: (SetRecord | null)[]): number[] {
  if (sets.length !== SETS_PER_EXERCISE) {
    throw new Error(`expected ${SETS_PER_EXERCISE} set slots, got ${sets.length}`);
  }
  const curve = new Array<number>(SEGMENT_COUNT);
  curve[0] = INITIAL_LOAD_LBS;
  for (let seg = 1; seg < SEGMENT_COUNT; seg++) {
    const prev = curve[seg - 1] as number;
    let qualifies = true;
    const base = (seg - 1) * SETS_PER_SEGMENT;
    for (let i = 0; i < SETS_PER_SEGMENT; i++) {
      const rec = sets[base + i];
      if (!rec || rec.reps < TARGET_REPS || rec.weightLbs < prev) {
        qualifies = false;
        break;
      }
    }
    curve[seg] = qualifies ? prev + INCREMENT_LBS : prev;
  }
  return curve;
}

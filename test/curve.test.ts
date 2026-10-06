import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { deriveExerciseCurve } from '../src/curve.js';
import {
  INITIAL_LOAD_LBS,
  SEGMENT_COUNT,
  SETS_PER_EXERCISE,
  SETS_PER_SEGMENT,
  SetRecord,
} from '../src/types.js';

function emptySets(): (SetRecord | null)[] {
  return new Array<SetRecord | null>(SETS_PER_EXERCISE).fill(null);
}

function fillSegment(
  sets: (SetRecord | null)[],
  segmentIndex: number,
  weightLbs: number,
  reps: number,
): void {
  for (let i = 0; i < SETS_PER_SEGMENT; i++) {
    const slot = segmentIndex * SETS_PER_SEGMENT + i;
    const setIndex = (slot % 3) + 1;
    const session = (Math.floor(slot / 3) % 3) + 1;
    const week = Math.floor(slot / 9) + 1;
    sets[slot] = { exerciseIndex: 1, week, session, setIndex, weightLbs, reps };
  }
}

test('empty history recommends 40 lbs for every segment', () => {
  deepEqual(deriveExerciseCurve(emptySets()), new Array(SEGMENT_COUNT).fill(INITIAL_LOAD_LBS));
});

test('fully qualifying segments increase by 5 lbs each segment', () => {
  const sets = emptySets();
  for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
    fillSegment(sets, seg, INITIAL_LOAD_LBS + 5 * seg, 10);
  }
  const curve = deriveExerciseCurve(sets);
  equal(curve.length, SEGMENT_COUNT);
  for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
    equal(curve[seg], INITIAL_LOAD_LBS + 5 * seg, `segment ${seg}`);
  }
});

test('a single missing record keeps the recommendation flat', () => {
  const sets = emptySets();
  fillSegment(sets, 0, 40, 10);
  sets[7] = null;
  const curve = deriveExerciseCurve(sets);
  equal(curve[1], 40);
});

test('reps below target keep the recommendation flat', () => {
  const sets = emptySets();
  fillSegment(sets, 0, 40, 10);
  (sets[3] as SetRecord).reps = 9;
  equal(deriveExerciseCurve(sets)[1], 40);
});

test('actual weight below the previous recommendation keeps it flat', () => {
  const sets = emptySets();
  fillSegment(sets, 0, 40, 10); // qualifies: seg1 = 45
  fillSegment(sets, 1, 44, 10); // 44 < 45: does not qualify
  fillSegment(sets, 2, 45, 10);
  const curve = deriveExerciseCurve(sets);
  equal(curve[1], 45);
  equal(curve[2], 45);
  equal(curve[3], 50, 'segment 2 qualifies against 45, so segment 3 rises');
});

test('a gap segment stops increases even if later segments qualify', () => {
  const sets = emptySets();
  fillSegment(sets, 0, 40, 10); // seg1 -> 45
  // segment 1 empty: seg2 stays 45
  fillSegment(sets, 2, 45, 10); // qualifies against 45: seg3 -> 50
  const curve = deriveExerciseCurve(sets);
  deepEqual(curve.slice(0, 4), [40, 45, 45, 50]);
});

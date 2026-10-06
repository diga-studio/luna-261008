import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTrainingModule,
  INITIAL_LOAD_LBS,
  INCREMENT_LBS,
  SEGMENT_COUNT,
  SETS_PER_EXERCISE,
  SESSIONS_PER_WEEK,
  SETS_PER_SESSION,
  TrainingModule,
  VersionedSetRecord,
} from '../src/index.js';

export function makeModule(): TrainingModule {
  return createTrainingModule(':memory:');
}

export function makeFileModule(): { module: TrainingModule; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'training-'));
  const dbPath = join(dir, 'training.db');
  return { module: createTrainingModule(dbPath), dbPath };
}

export function setKeyOfSlot(slot: number): { week: number; session: number; setIndex: number } {
  return {
    week: Math.floor(slot / (SESSIONS_PER_WEEK * SETS_PER_SESSION)) + 1,
    session: (Math.floor(slot / SETS_PER_SESSION) % SESSIONS_PER_WEEK) + 1,
    setIndex: (slot % SETS_PER_SESSION) + 1,
  };
}

/**
 * Seed a complete, fully qualifying cycle for one employee in a single
 * batch: every set recorded with reps 10 and weight equal to that segment's
 * recommendation (40, 45, 50, ...). Returns the commit sequence.
 */
export async function seedFullCycle(
  module: TrainingModule,
  employeeId: string,
  exerciseCount: number,
): Promise<number> {
  const batch = module.beginBatch(employeeId, `seed-${employeeId}`);
  for (let ex = 1; ex <= exerciseCount; ex++) {
    for (let slot = 0; slot < SETS_PER_EXERCISE; slot++) {
      const segment = Math.floor(slot / 18);
      const { week, session, setIndex } = setKeyOfSlot(slot);
      batch.add({
        kind: 'upsert',
        key: { exerciseIndex: ex, week, session, setIndex },
        weightLbs: INITIAL_LOAD_LBS + INCREMENT_LBS * segment,
        reps: 10,
        baseVersion: 0,
      });
    }
  }
  const result = await batch.commit();
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
  return result.commitSeq;
}

/** Read every set of one exercise from a view, as 468 chronological slots. */
export function readAllSlots(
  view: { readSegmentSets(exerciseIndex: number, segmentIndex: number): (VersionedSetRecord | null)[] },
  exerciseIndex: number,
): (VersionedSetRecord | null)[] {
  const slots: (VersionedSetRecord | null)[] = [];
  for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
    slots.push(...view.readSegmentSets(exerciseIndex, seg));
  }
  return slots;
}

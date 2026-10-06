import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { deriveExerciseCurve } from '../src/curve.js';
import { INITIAL_LOAD_LBS, INCREMENT_LBS, SEGMENT_COUNT, SetKey } from '../src/types.js';
import { makeModule, readAllSlots, seedFullCycle } from './helpers.js';

const EMP = 'emp-views';

test('an open view stays pinned while a cascading correction commits', async () => {
  const module = makeModule();
  module.createCycle(EMP, 2);
  await seedFullCycle(module, EMP, 2);

  const oldView = module.openView(EMP);
  const oldSeq = oldView.commitSeq;
  // Slow reader: reads only the first segment now, the rest later.
  const oldSeg0 = oldView.readSegmentSets(1, 0);
  equal(oldSeg0.length, 18);

  // A correction that cascades: drop one segment-0 set below target reps,
  // which flattens every later recommendation for exercise 1.
  const broken: SetKey = { exerciseIndex: 1, week: 1, session: 2, setIndex: 1 };
  const version = oldSeg0.find(
    (s) => s !== null && s.week === 1 && s.session === 2 && s.setIndex === 1,
  )!.version;
  const fix = module.beginBatch(EMP, 'cascade-fix');
  fix.add({ kind: 'upsert', key: broken, weightLbs: 40, reps: 5, baseVersion: version });
  const fixResult = await fix.commit();
  ok(fixResult.ok);

  // The old view keeps reading the pre-correction state, segment by segment.
  const oldSlots = readAllSlots(oldView, 1);
  const oldRec = oldSlots.find(
    (s) => s !== null && s.week === 1 && s.session === 2 && s.setIndex === 1,
  );
  equal(oldRec?.reps, 10, 'old view still sees the original reps');
  const oldCurve = oldView.readCurve()[0]!;
  for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
    equal(oldCurve[seg], INITIAL_LOAD_LBS + INCREMENT_LBS * seg, `old view segment ${seg}`);
  }
  equal(oldView.commitSeq, oldSeq, 'old view version unchanged');
  oldView.close();

  // A new view observes the committed correction and the re-derived curve.
  const newView = module.openView(EMP);
  ok(newView.commitSeq > oldSeq, 'new view pinned to the newer commit');
  const newSlots = readAllSlots(newView, 1);
  const newRec = newSlots.find(
    (s) => s !== null && s.week === 1 && s.session === 2 && s.setIndex === 1,
  );
  equal(newRec?.reps, 5);
  const newCurve = newView.readCurve()[0]!;
  equal(newCurve[1], 40, 'recommendation flattens after the broken segment');
  deepEqual(newCurve, deriveExerciseCurve(newSlots), 'new view curve matches independent derivation');
  // Exercise 2 was untouched.
  const ex2 = newView.readCurve()[1]!;
  equal(ex2[25], INITIAL_LOAD_LBS + INCREMENT_LBS * 25);
  newView.close();
  module.close();
});

test('a stalled batch blocks neither commits nor new views', async () => {
  const module = makeModule();
  module.createCycle(EMP, 2);
  const seedSeq = await seedFullCycle(module, EMP, 2);

  // A batch that stalls mid-input (never finishes during the assertions).
  const stalled = module.beginBatch(EMP, 'stalled');
  stalled.add({
    kind: 'upsert',
    key: { exerciseIndex: 2, week: 10, session: 1, setIndex: 1 },
    weightLbs: 99,
    reps: 10,
    baseVersion: seedSeq,
  });

  // A complete 10-set batch commits promptly.
  const ready = module.beginBatch(EMP, 'ready');
  for (let i = 0; i < 10; i++) {
    ready.add({
      kind: 'upsert',
      key: { exerciseIndex: 1, week: 20, session: 1, setIndex: 1 + (i % 3) },
      weightLbs: 80,
      reps: 10,
      baseVersion: seedSeq,
    });
  }
  const t0 = Date.now();
  const readyResult = await ready.commit();
  const commitMs = Date.now() - t0;
  ok(readyResult.ok, 'ready batch commits');
  ok(commitMs < 500, `commit took ${commitMs}ms (< 500ms)`);

  const t1 = Date.now();
  const view = module.openView(EMP);
  const openMs = Date.now() - t1;
  ok(openMs < 500, `view opened in ${openMs}ms (< 500ms)`);
  const seg = view.readSegmentSets(1, 9);
  ok(seg.some((s) => s !== null && s.weightLbs === 80), 'new view contains the committed batch');
  view.close();

  // The stalled batch has no effect until it commits, then commits cleanly.
  const view2 = module.openView(EMP);
  const stalledSlot = view2.readSegmentSets(2, 4).find(
    (s) => s !== null && s.week === 10 && s.session === 1 && s.setIndex === 1,
  );
  ok(stalledSlot !== null && stalledSlot !== undefined, 'seeded record exists');
  equal(stalledSlot.weightLbs, 60, 'stalled batch invisible before commit: seeded weight remains');
  view2.close();
  ok((await stalled.commit()).ok, 'stalled batch commits once input resumes');
  module.close();
});

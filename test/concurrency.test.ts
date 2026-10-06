import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { deriveExerciseCurve } from '../src/curve.js';
import { CommitResult, SetKey } from '../src/types.js';
import { makeModule, readAllSlots, seedFullCycle } from './helpers.js';

const EMP = 'emp-concurrent';

async function seeded() {
  const module = makeModule();
  module.createCycle(EMP, 3);
  await seedFullCycle(module, EMP, 3);
  return module;
}

function versionOf(module: ReturnType<typeof makeModule>, key: SetKey): number {
  const view = module.openView(EMP);
  const segment = Math.floor((key.week - 1) / 2);
  const sets = view.readSegmentSets(key.exerciseIndex, segment);
  const rec = sets.find((s) => s !== null && s.week === key.week && s.session === key.session && s.setIndex === key.setIndex);
  view.close();
  if (!rec) throw new Error('set not found');
  return rec.version;
}

test('concurrent corrections of different sets in one segment both succeed', async () => {
  const module = await seeded();
  const keyA: SetKey = { exerciseIndex: 1, week: 7, session: 1, setIndex: 1 };
  const keyB: SetKey = { exerciseIndex: 1, week: 8, session: 2, setIndex: 3 };
  const vA = versionOf(module, keyA);
  const vB = versionOf(module, keyB);

  const b1 = module.beginBatch(EMP, 'corr-1');
  b1.add({ kind: 'upsert', key: keyA, weightLbs: 120, reps: 12, baseVersion: vA });
  const b2 = module.beginBatch(EMP, 'corr-2');
  b2.add({ kind: 'upsert', key: keyB, weightLbs: 130, reps: 8, baseVersion: vB });
  const [r1, r2] = await Promise.all([b1.commit(), b2.commit()]);
  ok(r1.ok, 'first correction succeeds');
  ok(r2.ok, 'second correction succeeds');
  ok(r1.ok && r2.ok && r1.credential !== r2.credential, 'distinct credentials');

  const view = module.openView(EMP);
  const seg = view.readSegmentSets(1, 3);
  const recA = seg.find((s) => s !== null && s.week === 7 && s.session === 1 && s.setIndex === 1);
  const recB = seg.find((s) => s !== null && s.week === 8 && s.session === 2 && s.setIndex === 3);
  equal(recA?.weightLbs, 120);
  equal(recB?.weightLbs, 130);

  // Curve in the view must equal a from-scratch derivation over final records.
  for (let ex = 1; ex <= 3; ex++) {
    const derived = deriveExerciseCurve(readAllSlots(view, ex));
    deepEqual(view.readCurve()[ex - 1], derived, `exercise ${ex} curve`);
  }
  view.close();
  module.close();
});

test('overlapping batches on the same base version: exactly one succeeds', async () => {
  const module = await seeded();
  const keyA: SetKey = { exerciseIndex: 2, week: 3, session: 2, setIndex: 1 };
  const keyB: SetKey = { exerciseIndex: 2, week: 3, session: 2, setIndex: 2 };
  const vA = versionOf(module, keyA);
  const vB = versionOf(module, keyB);

  const b1 = module.beginBatch(EMP, 'over-1');
  b1.add({ kind: 'upsert', key: keyA, weightLbs: 200, reps: 10, baseVersion: vA });
  const b2 = module.beginBatch(EMP, 'over-2');
  b2.add({ kind: 'upsert', key: keyA, weightLbs: 210, reps: 10, baseVersion: vA });
  // A third batch touches a different set; employee-level state changed but
  // it must still succeed.
  const b3 = module.beginBatch(EMP, 'over-3');
  b3.add({ kind: 'upsert', key: keyB, weightLbs: 220, reps: 10, baseVersion: vB });

  const results: CommitResult[] = await Promise.all([b1.commit(), b2.commit(), b3.commit()]);
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  equal(succeeded.length, 2, 'two batches commit');
  equal(failed.length, 1, 'one overlapping batch is rejected');
  ok(!failed[0]!.ok && failed[0]!.conflicts.length === 1, 'conflict reported on the shared set');
  ok(results[2]!.ok, 'batch on a different set succeeds despite other commits');

  const view = module.openView(EMP);
  const seg = view.readSegmentSets(2, 1);
  const recA = seg.find((s) => s !== null && s.week === 3 && s.session === 2 && s.setIndex === 1);
  const recB = seg.find((s) => s !== null && s.week === 3 && s.session === 2 && s.setIndex === 2);
  // The loser left no trace: exactly one of the two competing weights landed.
  ok(recA?.weightLbs === 200 || recA?.weightLbs === 210, 'one winning correction present');
  equal(recB?.weightLbs, 220);
  const derived = deriveExerciseCurve(readAllSlots(view, 2));
  deepEqual(view.readCurve()[1], derived);
  view.close();
  module.close();
});

test('withdrawal counts as a change and re-derives later recommendations', async () => {
  const module = await seeded();
  const key: SetKey = { exerciseIndex: 3, week: 1, session: 1, setIndex: 1 };
  const v = versionOf(module, key);

  const before = module.openView(EMP);
  equal(before.readCurve()[2]![1], 45, 'seeded cycle qualifies for 45 in segment 1');
  before.close();

  const wd = module.beginBatch(EMP, 'wd-1');
  wd.add({ kind: 'withdraw', key, baseVersion: v });
  const wdResult = await wd.commit();
  ok(wdResult.ok, 'withdrawal commits');

  const after = module.openView(EMP);
  const curve = after.readCurve()[2]!;
  equal(curve[1], 40, 'missing record flattens segment 1');
  equal(curve[2], 45, 'later qualifying segments climb again from 40');
  equal(curve[25], 160, 'curve is shifted by one segment after the gap');
  deepEqual(curve, deriveExerciseCurve(readAllSlots(after, 3)), 'matches from-scratch derivation');
  const slot = after.readSegmentSets(3, 0).find(
    (s) => s === null || (s.week === 1 && s.session === 1 && s.setIndex === 1),
  );
  equal(slot ?? null, null, 'withdrawn set reads as no record');
  after.close();

  // A correction based on the pre-withdrawal version must now fail.
  const stale = module.beginBatch(EMP, 'stale-1');
  stale.add({ kind: 'upsert', key, weightLbs: 40, reps: 10, baseVersion: v });
  const staleResult = await stale.commit();
  ok(!staleResult.ok, 'stale base version rejected after withdrawal');

  // Re-recording with the withdrawal's version succeeds.
  ok(wdResult.ok);
  const redo = module.beginBatch(EMP, 'redo-1');
  redo.add({ kind: 'upsert', key, weightLbs: 40, reps: 10, baseVersion: wdResult.commitSeq });
  ok((await redo.commit()).ok, 're-record based on withdrawal version succeeds');
  module.close();
});

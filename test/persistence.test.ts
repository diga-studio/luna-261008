import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { createTrainingModule, SetKey } from '../src/index.js';
import { makeFileModule, seedFullCycle } from './helpers.js';

const EMP = 'emp-persist';
const KEY: SetKey = { exerciseIndex: 1, week: 5, session: 2, setIndex: 1 };

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), 0));
}

test('exit mid-input leaves no partial records after reopen', async () => {
  const { module, dbPath } = makeFileModule();
  module.createCycle(EMP, 2);
  const seedSeq = await seedFullCycle(module, EMP, 2);

  const partial = module.beginBatch(EMP, 'partial');
  partial.add({ kind: 'upsert', key: KEY, weightLbs: 77, reps: 7, baseVersion: seedSeq });
  // Process exits before the batch finishes input: nothing was committed.
  module.close();

  const reopened = createTrainingModule(dbPath);
  const view = reopened.openView(EMP);
  equal(view.commitSeq, seedSeq, 'no new commit from the unfinished batch');
  const seg = view.readSegmentSets(1, 2);
  const rec = seg.find((s) => s !== null && s.week === 5 && s.session === 2 && s.setIndex === 1);
  equal(rec?.weightLbs, 50, 'seeded value intact, partial input discarded');
  view.close();

  // The same batch id can be reused after restart and commits normally.
  const retry = reopened.beginBatch(EMP, 'partial');
  retry.add({ kind: 'upsert', key: KEY, weightLbs: 77, reps: 7, baseVersion: seedSeq });
  const result = await retry.commit();
  ok(result.ok, 'batch id reusable after restart');
  reopened.close();
});

test('commit completed but reply lost: retransmit returns the same credential', async () => {
  const { module, dbPath } = makeFileModule();
  module.createCycle(EMP, 2);
  const seedSeq = await seedFullCycle(module, EMP, 2);

  const batch = module.beginBatch(EMP, 'lost-reply');
  batch.add({ kind: 'upsert', key: KEY, weightLbs: 88, reps: 10, baseVersion: seedSeq });
  const commitPromise = batch.commit();
  await tick(); // let the synchronous commit land; the reply is then "lost"
  module.close();
  const first = await commitPromise;
  ok(first.ok);

  const reopened = createTrainingModule(dbPath);
  // Retransmit identical content; base versions are now stale, which must
  // not matter for an idempotent replay.
  const replay = reopened.beginBatch(EMP, 'lost-reply');
  replay.add({ kind: 'upsert', key: KEY, weightLbs: 88, reps: 10, baseVersion: seedSeq });
  const replayed = await replay.commit();
  ok(replayed.ok, 'retransmit of identical content succeeds');
  ok(first.ok && replayed.ok);
  equal(replayed.credential, first.credential, 'same credential as the first commit');
  equal(replayed.commitSeq, first.commitSeq, 'no new version produced');

  const view = reopened.openView(EMP);
  equal(view.commitSeq, first.commitSeq, 'commit sequence unchanged by replay');
  const rec = view
    .readSegmentSets(1, 2)
    .find((s) => s !== null && s.week === 5 && s.session === 2 && s.setIndex === 1);
  equal(rec?.weightLbs, 88);
  view.close();
  reopened.close();
});

test('retransmit does not override a later successful correction', async () => {
  const { module, dbPath } = makeFileModule();
  module.createCycle(EMP, 2);
  const seedSeq = await seedFullCycle(module, EMP, 2);

  const first = module.beginBatch(EMP, 'orig');
  first.add({ kind: 'upsert', key: KEY, weightLbs: 55, reps: 10, baseVersion: seedSeq });
  const firstResult = await first.commit();
  ok(firstResult.ok);

  const correction = module.beginBatch(EMP, 'correction');
  ok(firstResult.ok);
  correction.add({ kind: 'upsert', key: KEY, weightLbs: 66, reps: 10, baseVersion: firstResult.commitSeq });
  const correctionResult = await correction.commit();
  ok(correctionResult.ok);
  module.close();

  // After restart, the original batch is retransmitted (e.g. reply had been
  // lost). It must return its original credential and leave the later
  // correction untouched.
  const reopened = createTrainingModule(dbPath);
  const replay = reopened.beginBatch(EMP, 'orig');
  replay.add({ kind: 'upsert', key: KEY, weightLbs: 55, reps: 10, baseVersion: seedSeq });
  const replayResult = await replay.commit();
  ok(replayResult.ok);
  ok(firstResult.ok && replayResult.ok);
  equal(replayResult.credential, firstResult.credential);

  const view = reopened.openView(EMP);
  const rec = view
    .readSegmentSets(1, 2)
    .find((s) => s !== null && s.week === 5 && s.session === 2 && s.setIndex === 1);
  equal(rec?.weightLbs, 66, 'later correction survives the retransmission');
  ok(correctionResult.ok);
  equal(rec?.version, correctionResult.commitSeq, 'no new version from the replay');
  view.close();
  reopened.close();
});

test('same batch id with different content is rejected', async () => {
  const { module, dbPath } = makeFileModule();
  module.createCycle(EMP, 2);
  const seedSeq = await seedFullCycle(module, EMP, 2);

  const first = module.beginBatch(EMP, 'dup');
  first.add({ kind: 'upsert', key: KEY, weightLbs: 55, reps: 10, baseVersion: seedSeq });
  ok((await first.commit()).ok);
  module.close();

  const reopened = createTrainingModule(dbPath);
  const other: SetKey = { exerciseIndex: 1, week: 6, session: 1, setIndex: 1 };
  const replay = reopened.beginBatch(EMP, 'dup');
  replay.add({ kind: 'upsert', key: other, weightLbs: 55, reps: 10, baseVersion: seedSeq });
  const result = await replay.commit();
  ok(!result.ok, 'different content under a committed batch id is rejected');
  reopened.close();
});

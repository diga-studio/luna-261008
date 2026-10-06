import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { SETS_PER_EXERCISE } from '../src/types.js';
import { makeFileModule, seedFullCycle, setKeyOfSlot } from './helpers.js';

const EMPLOYEES = 100;
const EXERCISES = 20;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), 0));
}

test('scale: 100 employees x 20 exercises x full cycle, 32 concurrent batches', { timeout: 120000 }, async () => {
  const { module, dbPath } = makeFileModule();
  const t0 = Date.now();
  let seedSeq = 0;
  for (let i = 1; i <= EMPLOYEES; i++) {
    const emp = `perf-${i}`;
    module.createCycle(emp, EXERCISES);
    const seq = await seedFullCycle(module, emp, EXERCISES);
    if (i === 1) seedSeq = seq; // versions are global commit ids; keep perf-1's
  }
  const seedMs = Date.now() - t0;
  console.log(`seeded ${EMPLOYEES} employees (${EMPLOYEES * EXERCISES * SETS_PER_EXERCISE} sets) in ${seedMs}ms -> ${dbPath}`);

  // 32 batches fed concurrently (interleaved, asynchronous input) on one
  // employee, each touching a disjoint slice of 10 sets.
  const emp = 'perf-1';
  const handles = [];
  for (let b = 0; b < 32; b++) {
    handles.push(module.beginBatch(emp, `concurrent-${b}`));
  }
  for (let i = 0; i < 10; i++) {
    for (let b = 0; b < 32; b++) {
      const slot = 100 + b * 10 + i; // disjoint per batch
      const { week, session, setIndex } = setKeyOfSlot(slot);
      handles[b]!.add({
        kind: 'upsert',
        key: { exerciseIndex: 1, week, session, setIndex },
        weightLbs: 100 + b,
        reps: 10,
        baseVersion: seedSeq,
      });
    }
    await tick(); // simulate asynchronous trickle of input
  }
  const results = await Promise.all(handles.map((h) => h.commit()));
  ok(results.every((r) => r.ok), 'all 32 concurrent batches commit');
  const credentials = new Set(results.map((r) => (r.ok ? r.credential : '')));
  equal(credentials.size, 32, 'each batch gets a unique credential');

  // A stalled batch on the same employee: input pauses for 5 seconds.
  const stalled = module.beginBatch(emp, 'stalled-input');
  stalled.add({
    kind: 'upsert',
    key: { exerciseIndex: 2, week: 1, session: 1, setIndex: 1 },
    weightLbs: 41,
    reps: 10,
    baseVersion: seedSeq,
  });
  const stalledDone = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // input stalls
    stalled.add({
      kind: 'upsert',
      key: { exerciseIndex: 2, week: 1, session: 1, setIndex: 2 },
      weightLbs: 41,
      reps: 10,
      baseVersion: seedSeq,
    });
    return stalled.commit();
  })();

  // Meanwhile a complete 10-set batch must commit within 500ms.
  const ready = module.beginBatch(emp, 'ready-10');
  for (let i = 0; i < 10; i++) {
    const { week, session, setIndex } = setKeyOfSlot(450 + i);
    ready.add({
      kind: 'upsert',
      key: { exerciseIndex: 1, week, session, setIndex },
      weightLbs: 90,
      reps: 10,
      baseVersion: seedSeq,
    });
  }
  const t1 = Date.now();
  const readyResult = await ready.commit();
  const commitMs = Date.now() - t1;
  ok(readyResult.ok, 'ready batch commits during the stall');
  ok(commitMs < 500, `commit during stall took ${commitMs}ms (< 500ms)`);

  // And a new read view must open within 500ms.
  const t2 = Date.now();
  const view = module.openView(emp);
  const openMs = Date.now() - t2;
  ok(openMs < 500, `view opened during stall in ${openMs}ms (< 500ms)`);
  const t3 = Date.now();
  const curve = view.readCurve();
  const curveMs = Date.now() - t3;
  ok(curveMs < 500, `curve read took ${curveMs}ms (< 500ms)`);
  equal(curve.length, EXERCISES);
  view.close();

  const stalledResult = await stalledDone;
  ok(stalledResult.ok, 'stalled batch commits once its input resumes');
  module.close();
});

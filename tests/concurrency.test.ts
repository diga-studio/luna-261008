import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AuditStore } from '../src/store.ts';
import type { ChangeRequest, ChangeResult, ProjectDefinition } from '../src/types.ts';
import {
  Model,
  applyBoth,
  expectConsistent,
  resultsEqual,
  tmpDbPath,
  uniqueKey,
} from './helpers.ts';

function chainProject(projectId: string, length: number): ProjectDefinition {
  const steps = [];
  const dependencies = [];
  for (let i = 0; i < length; i += 1) {
    steps.push({ id: `s${i}`, text: `paper ${i}` });
    if (i > 0) {
      dependencies.push({ from: `s${i - 1}`, to: `s${i}` });
    }
  }
  return { projectId, steps, dependencies };
}

async function completeThrough(
  store: AuditStore,
  model: Model,
  projectId: string,
  lastCompleted: number,
  inReview: number,
): Promise<void> {
  for (let i = 0; i <= inReview; i += 1) {
    const version = model.snapshot().find((s) => s.id === `s${i}`)!.version;
    await applyBoth(store, model, projectId, {
      kind: 'submit',
      requestKey: uniqueKey(`submit-s${i}`),
      stepId: `s${i}`,
      expectedVersion: version,
    });
    if (i <= lastCompleted) {
      await applyBoth(store, model, projectId, {
        kind: 'signoff',
        requestKey: uniqueKey(`signoff-s${i}`),
        stepId: `s${i}`,
        expectedVersion: version + 1,
      });
    }
  }
}

function dispatch(store: AuditStore, projectId: string, req: ChangeRequest): Promise<ChangeResult> {
  if (req.kind === 'submit') {
    return store.submit(projectId, req);
  }
  if (req.kind === 'signoff') {
    return store.signoff(projectId, req);
  }
  return store.rework(projectId, req);
}

/**
 * Replays the observed results against the model, greedily finding an order
 * in which every operation produces exactly the result the store returned.
 * Proves the concurrent execution was equivalent to a serial one.
 */
function reconstructSerialOrder(
  initial: Model,
  ops: { req: ChangeRequest; result: ChangeResult }[],
): Model {
  let current = initial.fork();
  const pool = [...ops];
  while (pool.length > 0) {
    const index = pool.findIndex((op) => resultsEqual(current.fork().apply(op.req), op.result));
    if (index === -1) {
      const remaining = pool.map((op) => `${op.req.kind}@${op.req.stepId}`).join(', ');
      throw new Error(`no legal serial order; stuck with: ${remaining}`);
    }
    const [chosen] = pool.splice(index, 1);
    current = current.fork();
    current.apply(chosen!.req);
  }
  return current;
}

test('32 concurrent mutations (incl. replays) are equivalent to some serial order', async () => {
  const projectId = 'proj-concurrency';
  const def = chainProject(projectId, 8);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);
  // s0..s5 completed, s6 in review, s7 todo.
  await completeThrough(store, model, projectId, 5, 6);

  const ops: ChangeRequest[] = [
    { kind: 'rework', requestKey: uniqueKey('rw0'), stepId: 's0', expectedVersion: 2 },
    { kind: 'rework', requestKey: uniqueKey('rw3'), stepId: 's3', expectedVersion: 2 },
    { kind: 'signoff', requestKey: uniqueKey('so6'), stepId: 's6', expectedVersion: 1 },
    { kind: 'submit', requestKey: uniqueKey('sub7'), stepId: 's7', expectedVersion: 0, text: 'paper 7 v2' },
    { kind: 'rework', requestKey: uniqueKey('rw6'), stepId: 's6', expectedVersion: 1 },
    { kind: 'signoff', requestKey: uniqueKey('so5'), stepId: 's5', expectedVersion: 2 },
    { kind: 'submit', requestKey: uniqueKey('sub6'), stepId: 's6', expectedVersion: 1 },
    { kind: 'rework', requestKey: uniqueKey('rw7'), stepId: 's7', expectedVersion: 0 },
  ];

  // Fire each unique request 4 times concurrently: 32 in-flight calls.
  const results = await Promise.all(
    Array.from({ length: 4 }, () => ops).flat().map((req) => dispatch(store, projectId, req)),
  );

  // Replays of the same key must all observe the identical outcome.
  const byKey = new Map<string, ChangeResult>();
  for (const [index, req] of Array.from({ length: 4 }, () => ops).flat().entries()) {
    const result = results[index]!;
    const first = byKey.get(req.requestKey);
    if (first === undefined) {
      byKey.set(req.requestKey, result);
    } else {
      ok(resultsEqual(result, first), `replay of ${req.requestKey} returned a different result`);
    }
  }

  const uniqueResults = ops.map((req) => ({ req, result: byKey.get(req.requestKey)! }));
  const serialModel = reconstructSerialOrder(model, uniqueResults);
  await expectConsistent(store, serialModel, projectId, def.dependencies);
  store.close();
});

test('concurrent upstream rework and downstream sign-off match a legal serial order', async () => {
  const projectId = 'proj-race';
  const def = chainProject(projectId, 3);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);
  await completeThrough(store, model, projectId, 1, 2);

  const reworkReq: ChangeRequest = {
    kind: 'rework',
    requestKey: uniqueKey('race-rework'),
    stepId: 's0',
    expectedVersion: 2,
  };
  const signoffReq: ChangeRequest = {
    kind: 'signoff',
    requestKey: uniqueKey('race-signoff'),
    stepId: 's2',
    expectedVersion: 1,
  };
  const [reworkResult, signoffResult] = await Promise.all([
    store.rework(projectId, reworkReq),
    store.signoff(projectId, signoffReq),
  ]);

  // Serial order 1: sign-off first, then rework (both succeed).
  const order1 = model.fork();
  const o1Signoff = order1.apply(signoffReq);
  const o1Rework = order1.apply(reworkReq);
  // Serial order 2: rework first (sign-off then hits a version conflict).
  const order2 = model.fork();
  const o2Rework = order2.apply(reworkReq);
  const o2Signoff = order2.apply(signoffReq);

  const matchesOrder1 = resultsEqual(reworkResult, o1Rework) && resultsEqual(signoffResult, o1Signoff);
  const matchesOrder2 = resultsEqual(reworkResult, o2Rework) && resultsEqual(signoffResult, o2Signoff);
  ok(matchesOrder1 || matchesOrder2, 'outcome matches no legal serial order');
  await expectConsistent(store, matchesOrder1 ? order1 : order2, projectId, def.dependencies);
  store.close();
});

test('sign-off with a pre-rework version is rejected after resubmission', async () => {
  const projectId = 'proj-stale-signoff';
  const def = chainProject(projectId, 2);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);
  await completeThrough(store, model, projectId, 1, 1);

  // Rework s0: both steps fall back to todo, versions +1, text kept.
  await applyBoth(store, model, projectId, {
    kind: 'rework',
    requestKey: uniqueKey('rework-s0'),
    stepId: 's0',
    expectedVersion: 2,
  });
  // Re-complete s0, then resubmit s1 (text unchanged by the rework).
  await completeThrough(store, model, projectId, 0, 1);

  const s1 = model.snapshot().find((s) => s.id === 's1')!;
  equal(s1.status, 'in_review');
  equal(s1.text, 'paper 1');

  // A sign-off carrying the pre-rework version must conflict even though the
  // step is again in review with unchanged text.
  const stale = await store.signoff(projectId, {
    kind: 'signoff',
    requestKey: uniqueKey('stale-signoff'),
    stepId: 's1',
    expectedVersion: 2,
  });
  deepEqualTypes(stale, { type: 'version_conflict', stepId: 's1', currentVersion: s1.version });
  await expectConsistent(store, model, projectId, def.dependencies);

  // The current version signs off cleanly.
  await applyBoth(store, model, projectId, {
    kind: 'signoff',
    requestKey: uniqueKey('fresh-signoff'),
    stepId: 's1',
    expectedVersion: s1.version,
  });
  await expectConsistent(store, model, projectId, def.dependencies);
  store.close();
});

function deepEqualTypes(actual: ChangeResult, expected: ChangeResult): void {
  ok(resultsEqual(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

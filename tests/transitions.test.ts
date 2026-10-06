import { test } from 'node:test';
import { equal, throws } from 'node:assert/strict';
import { AuditStore } from '../src/store.ts';
import type { ProjectDefinition } from '../src/types.ts';
import { Model, applyBoth, expectConsistent, tmpDbPath, uniqueKey } from './helpers.ts';

function twoStepProject(projectId: string): ProjectDefinition {
  return {
    projectId,
    steps: [
      { id: 'A', text: 'paper A' },
      { id: 'B', text: 'paper B' },
    ],
    dependencies: [{ from: 'A', to: 'B' }],
  };
}

test('submit updates text and enforces status and predecessor rules', async () => {
  const projectId = 'proj-transitions';
  const def = twoStepProject(projectId);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);

  // B cannot be submitted while A is incomplete.
  const earlyB = await store.submit(projectId, {
    kind: 'submit', requestKey: uniqueKey('sub'), stepId: 'B', expectedVersion: 0,
  });
  equal(earlyB.type, 'precondition_failed');

  // Sign-off only works from in_review.
  const earlySignoff = await store.signoff(projectId, {
    kind: 'signoff', requestKey: uniqueKey('so'), stepId: 'A', expectedVersion: 0,
  });
  equal(earlySignoff.type, 'precondition_failed');

  // Submit updates the working-paper text.
  await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: uniqueKey('sub'), stepId: 'A', expectedVersion: 0, text: 'paper A revised',
  });
  // Submit only works from todo.
  const resubmit = await store.submit(projectId, {
    kind: 'submit', requestKey: uniqueKey('sub'), stepId: 'A', expectedVersion: 1,
  });
  equal(resubmit.type, 'precondition_failed');

  await applyBoth(store, model, projectId, {
    kind: 'signoff', requestKey: uniqueKey('so'), stepId: 'A', expectedVersion: 1,
  });
  // Sign-off only works from in_review (A is now completed).
  const resignoff = await store.signoff(projectId, {
    kind: 'signoff', requestKey: uniqueKey('so'), stepId: 'A', expectedVersion: 2,
  });
  equal(resignoff.type, 'precondition_failed');

  // Now B can flow through; text stays when submit omits it.
  await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: uniqueKey('sub'), stepId: 'B', expectedVersion: 0,
  });
  await applyBoth(store, model, projectId, {
    kind: 'signoff', requestKey: uniqueKey('so'), stepId: 'B', expectedVersion: 1,
  });

  const steps = await expectConsistent(store, model, projectId, def.dependencies);
  equal(steps.find((s) => s.id === 'A')!.text, 'paper A revised');
  equal(steps.find((s) => s.id === 'B')!.text, 'paper B');

  // Unknown steps and unknown projects fail as precondition violations.
  const unknown = await store.submit(projectId, {
    kind: 'submit', requestKey: uniqueKey('sub'), stepId: 'ZZ', expectedVersion: 0,
  });
  equal(unknown.type, 'precondition_failed');
  store.close();
});

test('initProject rejects invalid graphs and duplicate initialization', async () => {
  const store = new AuditStore(tmpDbPath());
  const base = twoStepProject('proj-valid');
  store.initProject(base);
  throws(() => store.initProject(base), /already exists/);
  throws(() =>
    store.initProject({
      projectId: 'p-dup-step',
      steps: [
        { id: 'A', text: 'a' },
        { id: 'A', text: 'b' },
      ],
      dependencies: [],
    }),
  );
  throws(() =>
    store.initProject({
      projectId: 'p-unknown',
      steps: [{ id: 'A', text: 'a' }],
      dependencies: [{ from: 'A', to: 'B' }],
    }),
  );
  throws(() =>
    store.initProject({
      projectId: 'p-cycle',
      steps: [
        { id: 'A', text: 'a' },
        { id: 'B', text: 'b' },
      ],
      dependencies: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    }),
  );
  store.close();
});

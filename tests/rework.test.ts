import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { AuditStore } from '../src/store.ts';
import type { ProjectDefinition } from '../src/types.ts';
import { Model, applyBoth, expectConsistent, tmpDbPath, uniqueKey } from './helpers.ts';

/**
 * Two-layer diamond graph plus an unrelated branch:
 *   A -> B,C,D ; B,C,D -> E ; E -> F,G ; F,G -> H ; X -> Y
 */
function diamondProject(projectId: string): ProjectDefinition {
  return {
    projectId,
    steps: [
      { id: 'A', text: 'paper A' },
      { id: 'B', text: 'paper B' },
      { id: 'C', text: 'paper C' },
      { id: 'D', text: 'paper D' },
      { id: 'E', text: 'paper E' },
      { id: 'F', text: 'paper F' },
      { id: 'G', text: 'paper G' },
      { id: 'H', text: 'paper H' },
      { id: 'X', text: 'paper X' },
      { id: 'Y', text: 'paper Y' },
    ],
    dependencies: [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'A', to: 'D' },
      { from: 'B', to: 'E' },
      { from: 'C', to: 'E' },
      { from: 'D', to: 'E' },
      { from: 'E', to: 'F' },
      { from: 'E', to: 'G' },
      { from: 'F', to: 'H' },
      { from: 'G', to: 'H' },
      { from: 'X', to: 'Y' },
    ],
  };
}

async function completeStep(store: AuditStore, model: Model, projectId: string, stepId: string): Promise<void> {
  const version = model.snapshot().find((s) => s.id === stepId)!.version;
  await applyBoth(store, model, projectId, {
    kind: 'submit',
    requestKey: uniqueKey(`submit-${stepId}`),
    stepId,
    expectedVersion: version,
  });
  await applyBoth(store, model, projectId, {
    kind: 'signoff',
    requestKey: uniqueKey(`signoff-${stepId}`),
    stepId,
    expectedVersion: version + 1,
  });
}

test('rework in multi-layer diamond bumps shared successors once and leaves side branches untouched', async () => {
  const projectId = 'proj-diamond';
  const def = diamondProject(projectId);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);

  for (const stepId of ['A', 'B', 'C', 'D', 'E', 'F', 'X']) {
    await completeStep(store, model, projectId, stepId);
  }
  await expectConsistent(store, model, projectId, def.dependencies);

  const before = new Map(model.snapshot().map((s) => [s.id, s]));
  const reworkResult = await applyBoth(store, model, projectId, {
    kind: 'rework',
    requestKey: uniqueKey('rework-B'),
    stepId: 'B',
    expectedVersion: before.get('B')!.version,
  });
  equal(reworkResult.type, 'ok');
  if (reworkResult.type !== 'ok') {
    throw new Error('unreachable');
  }

  const affectedIds = reworkResult.affected.map((a) => a.stepId).sort();
  deepEqual(affectedIds, ['B', 'E', 'F', 'G', 'H']);

  const after = new Map((await expectConsistent(store, model, projectId, def.dependencies)).map((s) => [s.id, s]));

  // Every affected step gained exactly one version, even E (three incoming
  // paths from B's layer) and H (reachable via both F and G), and even G
  // which was already 'todo'.
  for (const id of affectedIds) {
    equal(after.get(id)!.version, before.get(id)!.version + 1, `version of ${id}`);
    equal(after.get(id)!.status, 'todo', `status of ${id}`);
    equal(after.get(id)!.text, before.get(id)!.text, `text of ${id} preserved`);
  }
  // Everything outside the rework scope is completely unchanged.
  for (const id of ['A', 'C', 'D', 'X', 'Y']) {
    deepEqual(after.get(id), before.get(id), `step ${id} unchanged`);
  }

  // Stale expected version on a second rework conflicts and changes nothing.
  const conflict = await store.rework(projectId, {
    kind: 'rework',
    requestKey: uniqueKey('rework-B-stale'),
    stepId: 'B',
    expectedVersion: before.get('B')!.version,
  });
  deepEqual(conflict, { type: 'version_conflict', stepId: 'B', currentVersion: before.get('B')!.version + 1 });
  await expectConsistent(store, model, projectId, def.dependencies);

  // E is back to 'todo' and its predecessor B is not completed: submit fails.
  const submitE = await store.submit(projectId, {
    kind: 'submit',
    requestKey: uniqueKey('submit-E-early'),
    stepId: 'E',
    expectedVersion: after.get('E')!.version,
  });
  equal(submitE.type, 'precondition_failed');
  await expectConsistent(store, model, projectId, def.dependencies);

  store.close();
});

test('rework of a todo step still bumps its version by one', async () => {
  const projectId = 'proj-todo-rework';
  const def = diamondProject(projectId);
  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);

  const result = await applyBoth(store, model, projectId, {
    kind: 'rework',
    requestKey: uniqueKey('rework-H'),
    stepId: 'H',
    expectedVersion: 0,
  });
  equal(result.type, 'ok');
  const steps = await expectConsistent(store, model, projectId, def.dependencies);
  const h = steps.find((s) => s.id === 'H')!;
  equal(h.version, 1);
  equal(h.status, 'todo');
  equal(h.text, 'paper H');
  store.close();
});

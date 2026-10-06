import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { AuditStore } from '../src/store.ts';
import type { ProjectDefinition } from '../src/types.ts';
import { Model, applyBoth, expectConsistent, tmpDbPath } from './helpers.ts';

function chainProject(projectId: string): ProjectDefinition {
  return {
    projectId,
    steps: [
      { id: 'A', text: 'paper A' },
      { id: 'B', text: 'paper B' },
      { id: 'C', text: 'paper C' },
    ],
    dependencies: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ],
  };
}

test('successful requests replay identically after further changes and reopen', async () => {
  const projectId = 'proj-idempotency';
  const def = chainProject(projectId);
  const dbPath = tmpDbPath();
  const model = new Model(def);

  let store = new AuditStore(dbPath);
  store.initProject(def);

  const submitA = await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: 'k-submit-A', stepId: 'A', expectedVersion: 0, text: 'paper A draft 2',
  });
  const signoffA = await applyBoth(store, model, projectId, {
    kind: 'signoff', requestKey: 'k-signoff-A', stepId: 'A', expectedVersion: 1,
  });
  await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: 'k-submit-B', stepId: 'B', expectedVersion: 0,
  });
  const reworkA = await applyBoth(store, model, projectId, {
    kind: 'rework', requestKey: 'k-rework-A', stepId: 'A', expectedVersion: 2,
  });
  equal(reworkA.type, 'ok');

  // Replay of the old submit: returns the original result even though the
  // expected version no longer matches (replay wins over version checks),
  // and does not resurrect the review state undone by the rework.
  const replaySubmit = await store.submit(projectId, {
    kind: 'submit', requestKey: 'k-submit-A', stepId: 'A', expectedVersion: 0, text: 'paper A draft 2',
  });
  deepEqual(replaySubmit, submitA);
  const replaySignoff = await store.signoff(projectId, {
    kind: 'signoff', requestKey: 'k-signoff-A', stepId: 'A', expectedVersion: 1,
  });
  deepEqual(replaySignoff, signoffA);
  // Replayed rework must not bump versions a second time.
  const replayRework = await store.rework(projectId, {
    kind: 'rework', requestKey: 'k-rework-A', stepId: 'A', expectedVersion: 2,
  });
  deepEqual(replayRework, reworkA);
  await expectConsistent(store, model, projectId, def.dependencies);

  // Same key with different content is rejected and changes nothing.
  const conflict = await store.submit(projectId, {
    kind: 'submit', requestKey: 'k-submit-A', stepId: 'A', expectedVersion: 0, text: 'different text',
  });
  deepEqual(conflict, { type: 'request_key_conflict', requestKey: 'k-submit-A' });
  await expectConsistent(store, model, projectId, def.dependencies);

  // Unsuccessful requests do not consume their key.
  const failedSignoff = await store.signoff(projectId, {
    kind: 'signoff', requestKey: 'k-reused', stepId: 'B', expectedVersion: 2,
  });
  equal(failedSignoff.type, 'precondition_failed');
  const failedVersion = await store.submit(projectId, {
    kind: 'submit', requestKey: 'k-reused-version', stepId: 'A', expectedVersion: 99,
  });
  equal(failedVersion.type, 'version_conflict');
  const reused = await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: 'k-reused', stepId: 'A', expectedVersion: 3,
  });
  equal(reused.type, 'ok');
  const reusedVersion = await applyBoth(store, model, projectId, {
    kind: 'signoff', requestKey: 'k-reused-version', stepId: 'A', expectedVersion: 4,
  });
  equal(reusedVersion.type, 'ok');
  await expectConsistent(store, model, projectId, def.dependencies);

  // Reopen the database: replays still return the original results and the
  // state survives intact.
  store.close();
  store = new AuditStore(dbPath);
  const afterReopenSubmit = await store.submit(projectId, {
    kind: 'submit', requestKey: 'k-submit-A', stepId: 'A', expectedVersion: 0, text: 'paper A draft 2',
  });
  deepEqual(afterReopenSubmit, submitA);
  const afterReopenRework = await store.rework(projectId, {
    kind: 'rework', requestKey: 'k-rework-A', stepId: 'A', expectedVersion: 2,
  });
  deepEqual(afterReopenRework, reworkA);
  const afterReopenConflict = await store.submit(projectId, {
    kind: 'submit', requestKey: 'k-submit-A', stepId: 'A', expectedVersion: 0, text: 'yet another text',
  });
  deepEqual(afterReopenConflict, { type: 'request_key_conflict', requestKey: 'k-submit-A' });
  await expectConsistent(store, model, projectId, def.dependencies);

  // The project keeps working normally after reopen.
  const next = await applyBoth(store, model, projectId, {
    kind: 'submit', requestKey: 'k-after-reopen', stepId: 'B', expectedVersion: 2,
  });
  equal(next.type, 'ok');
  await expectConsistent(store, model, projectId, def.dependencies);
  store.close();
});

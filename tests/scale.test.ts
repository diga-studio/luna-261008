import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { AuditStore } from '../src/store.ts';
import type { ProjectDefinition } from '../src/types.ts';
import { Model, applyBoth, descendants, expectConsistent, tmpDbPath, uniqueKey } from './helpers.ts';

const LAYERS = 100;
const WIDTH = 100;
const FAN_OUT = 5;

/** 100 layers x 100 nodes = 10000 steps, 49500 dependency edges. */
function wideProject(projectId: string): ProjectDefinition {
  const steps = [];
  const dependencies = [];
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let node = 0; node < WIDTH; node += 1) {
      steps.push({ id: `L${layer}N${node}`, text: `paper ${layer}/${node}` });
    }
  }
  for (let layer = 0; layer + 1 < LAYERS; layer += 1) {
    for (let node = 0; node < WIDTH; node += 1) {
      for (let k = 0; k < FAN_OUT; k += 1) {
        dependencies.push({
          from: `L${layer}N${node}`,
          to: `L${layer + 1}N${(node + k) % WIDTH}`,
        });
      }
    }
  }
  return { projectId, steps, dependencies };
}

test('supports 10000 steps and 50000 dependencies with a project-wide rework', async () => {
  const projectId = 'proj-scale';
  const def = wideProject(projectId);
  equal(def.steps.length, 10000);
  equal(def.dependencies.length, 49500);

  const store = new AuditStore(tmpDbPath());
  const model = new Model(def);
  store.initProject(def);

  // Complete the first layer so the rework undoes real sign-offs.
  for (let node = 0; node < WIDTH; node += 1) {
    const id = `L0N${node}`;
    await applyBoth(store, model, projectId, {
      kind: 'submit', requestKey: uniqueKey('sub'), stepId: id, expectedVersion: 0,
    });
    await applyBoth(store, model, projectId, {
      kind: 'signoff', requestKey: uniqueKey('so'), stepId: id, expectedVersion: 1,
    });
  }

  // 32 concurrent identical reworks: one executes, the rest replay.
  const reworkReq = {
    kind: 'rework' as const,
    requestKey: uniqueKey('rework-root'),
    stepId: 'L0N0',
    expectedVersion: 2,
  };
  const expectedAffected = descendants(def.dependencies, 'L0N0').length;
  const results = await Promise.all(Array.from({ length: 32 }, () => store.rework(projectId, reworkReq)));
  for (const result of results) {
    equal(result.type, 'ok');
    if (result.type === 'ok') {
      equal(result.affected.length, expectedAffected);
    }
  }
  model.apply(reworkReq);

  const steps = await expectConsistent(store, model, projectId, def.dependencies);
  const affectedSet = new Set(descendants(def.dependencies, 'L0N0'));
  for (const step of steps) {
    if (affectedSet.has(step.id)) {
      equal(step.status, 'todo');
      equal(step.version, step.id.startsWith('L0N') ? 3 : 1);
    } else {
      equal(step.status, step.id.startsWith('L0N') ? 'completed' : 'todo');
      equal(step.version, step.id.startsWith('L0N') ? 2 : 0);
    }
  }
  store.close();
});

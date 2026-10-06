import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition, DefinitionError } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';

const valid: WorkflowDefinition = {
  id: 'w',
  entry: 'a',
  nodes: [
    { id: 'a', kind: 'task' },
    { id: 'b', kind: 'task' },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

test('接受合法定义', () => {
  assert.doesNotThrow(() => validateDefinition(valid));
});

test('拒绝环', () => {
  const def: WorkflowDefinition = {
    ...valid,
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  };
  assert.throws(() => validateDefinition(def), DefinitionError);
});

test('拒绝未知入口与悬空边', () => {
  assert.throws(
    () => validateDefinition({ ...valid, entry: 'nope' }),
    DefinitionError,
  );
  assert.throws(
    () => validateDefinition({ ...valid, edges: [{ from: 'a', to: 'ghost' }] }),
    DefinitionError,
  );
});

test('只有汇合允许多个入口', () => {
  const def: WorkflowDefinition = {
    id: 'w',
    entry: 'f',
    nodes: [
      { id: 'f', kind: 'fork' },
      { id: 'a', kind: 'task' },
      { id: 'b', kind: 'task' },
      { id: 'c', kind: 'task' },
    ],
    edges: [
      { from: 'f', to: 'a' },
      { from: 'f', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ],
  };
  assert.throws(() => validateDefinition(def), /only join/);
});

test('决策网关必须紧接人工任务且一真一假两条出边', () => {
  const base: WorkflowDefinition = {
    id: 'w',
    entry: 't',
    nodes: [
      { id: 't', kind: 'task' },
      { id: 'd', kind: 'decision' },
      { id: 'x', kind: 'task' },
      { id: 'y', kind: 'task' },
    ],
    edges: [
      { from: 't', to: 'd' },
      { from: 'd', to: 'x', condition: true },
      { from: 'd', to: 'y', condition: false },
    ],
  };
  assert.doesNotThrow(() => validateDefinition(base));
  assert.throws(
    () =>
      validateDefinition({
        ...base,
        edges: [
          { from: 't', to: 'd' },
          { from: 'd', to: 'x', condition: true },
          { from: 'd', to: 'y', condition: true },
        ],
      }),
    DefinitionError,
  );
  assert.throws(
    () =>
      validateDefinition({
        ...base,
        nodes: [
          { id: 't', kind: 'fork' },
          { id: 'd', kind: 'decision' },
          { id: 'x', kind: 'task' },
          { id: 'y', kind: 'task' },
        ],
      }),
    /directly follow a task/,
  );
});

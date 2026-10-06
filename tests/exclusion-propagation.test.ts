import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine, WorkflowError } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';
import { executedSet, reachableSet, skippedSet, statusMap } from './helpers.ts';

/**
 * 全部入口被排除后的连续传播 + 下游交叉汇合：
 *   f0(分叉) -> t1, t2
 *   t1 -> d1(决策)
 *   d1 -true->  tA                 (真实支路，终点任务)
 *   d1 -false-> f1(分叉) -> tB, tC
 *   tB -> j1, tC -> j1             (j1: 两个入口都来自 false 支路)
 *   j1 -> tD -> j2                 (排除沿 tD 继续传播)
 *   t2 -> j2                       (j2: 交叉汇合，另一入口来自无关支路)
 *   j2 -> tEnd
 */
const def: WorkflowDefinition = {
  id: 'exclusion-propagation',
  entry: 'f0',
  nodes: [
    { id: 'f0', kind: 'fork' },
    { id: 't1', kind: 'task' },
    { id: 't2', kind: 'task' },
    { id: 'd1', kind: 'decision' },
    { id: 'tA', kind: 'task' },
    { id: 'f1', kind: 'fork' },
    { id: 'tB', kind: 'task' },
    { id: 'tC', kind: 'task' },
    { id: 'j1', kind: 'join' },
    { id: 'tD', kind: 'task' },
    { id: 'j2', kind: 'join' },
    { id: 'tEnd', kind: 'task' },
  ],
  edges: [
    { from: 'f0', to: 't1' },
    { from: 'f0', to: 't2' },
    { from: 't1', to: 'd1' },
    { from: 'd1', to: 'tA', condition: true },
    { from: 'd1', to: 'f1', condition: false },
    { from: 'f1', to: 'tB' },
    { from: 'f1', to: 'tC' },
    { from: 'tB', to: 'j1' },
    { from: 'tC', to: 'j1' },
    { from: 'j1', to: 'tD' },
    { from: 'tD', to: 'j2' },
    { from: 't2', to: 'j2' },
    { from: 'j2', to: 'tEnd' },
  ],
};

function setup(): { engine: WorkflowEngine; instanceId: string } {
  const engine = new WorkflowEngine();
  engine.defineWorkflow(def);
  return { engine, instanceId: engine.startInstance(def.id) };
}

test('全部入口被排除后汇合不执行，排除连续传播到下游', () => {
  const { engine, instanceId } = setup();

  // t1=true：false 支路整体被排除，j1 全部入口均确定不会到达
  engine.submitResult(instanceId, 't1', true);
  const status = statusMap(engine.getStatus(instanceId));

  // 排除传播无需提交任何虚构任务结果，一次提交内全部生效
  assert.equal(status.get('f1'), 'skipped');
  assert.equal(status.get('tB'), 'skipped');
  assert.equal(status.get('tC'), 'skipped');
  assert.equal(status.get('j1'), 'skipped');
  assert.equal(status.get('tD'), 'skipped');

  // 下游交叉汇合 j2 仍有来自 t2 的实际入口，不能被一并跳过
  assert.equal(status.get('j2'), 'pending');
  assert.equal(status.get('tA'), 'todo');
  assert.equal(status.get('t2'), 'todo');

  // 被排除的任务不接受提交
  assert.throws(() => engine.submitResult(instanceId, 'tB'), WorkflowError);
  assert.throws(() => engine.submitResult(instanceId, 'tD'), WorkflowError);

  engine.submitResult(instanceId, 'tA');
  engine.submitResult(instanceId, 't2');
  const after = statusMap(engine.getStatus(instanceId));
  assert.equal(after.get('j2'), 'done');
  assert.equal(after.get('tEnd'), 'todo');

  engine.submitResult(instanceId, 'tEnd');
  const final = engine.getStatus(instanceId);
  assert.equal(final.state, 'completed');
  assert.deepEqual(executedSet(final), reachableSet(def, new Map([['t1', true]])));
  assert.deepEqual(skippedSet(final), new Set(['f1', 'tB', 'tC', 'j1', 'tD']));
});

test('走 false 支路时 j1 正常放行，j2 等待两个实际入口到齐', () => {
  const { engine, instanceId } = setup();

  engine.submitResult(instanceId, 't1', false);
  let status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('tA'), 'skipped');
  assert.equal(status.get('tB'), 'todo');
  assert.equal(status.get('tC'), 'todo');
  assert.equal(status.get('j1'), 'pending');

  // j1 的一个入口到达、另一个未决：必须等待
  engine.submitResult(instanceId, 'tB');
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j1'), 'pending');
  assert.equal(status.get('tD'), 'pending');

  engine.submitResult(instanceId, 'tC');
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j1'), 'done');
  assert.equal(status.get('tD'), 'todo');

  // j2 的一个入口（tD）到达、另一个（t2）未决：必须等待
  engine.submitResult(instanceId, 'tD');
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j2'), 'pending');
  assert.equal(status.get('tEnd'), 'pending');

  engine.submitResult(instanceId, 't2');
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j2'), 'done');
  assert.equal(status.get('tEnd'), 'todo');

  engine.submitResult(instanceId, 'tEnd');
  const final = engine.getStatus(instanceId);
  assert.equal(final.state, 'completed');
  assert.deepEqual(executedSet(final), reachableSet(def, new Map([['t1', false]])));
  assert.deepEqual(skippedSet(final), new Set(['tA']));
});

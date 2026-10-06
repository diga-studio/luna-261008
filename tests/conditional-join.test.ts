import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine, WorkflowError } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';
import { executedSet, reachableSet, skippedSet, statusMap } from './helpers.ts';

/**
 * 两条条件支路通向同一汇合 j：
 *   f0(分叉) -> t1, tOther(无关任务)
 *   t1 -> d1(决策)
 *   d1 -true->  tA -> j
 *   d1 -false-> j          (绕过 tA 直接进入汇合)
 *   j -> tEnd
 */
const def: WorkflowDefinition = {
  id: 'conditional-join',
  entry: 'f0',
  nodes: [
    { id: 'f0', kind: 'fork' },
    { id: 't1', kind: 'task' },
    { id: 'tOther', kind: 'task' },
    { id: 'd1', kind: 'decision' },
    { id: 'tA', kind: 'task' },
    { id: 'j', kind: 'join' },
    { id: 'tEnd', kind: 'task' },
  ],
  edges: [
    { from: 'f0', to: 't1' },
    { from: 'f0', to: 'tOther' },
    { from: 't1', to: 'd1' },
    { from: 'd1', to: 'tA', condition: true },
    { from: 'd1', to: 'j', condition: false },
    { from: 'tA', to: 'j' },
    { from: 'j', to: 'tEnd' },
  ],
};

function setup(): { engine: WorkflowEngine; instanceId: string } {
  const engine = new WorkflowEngine();
  engine.defineWorkflow(def);
  return { engine, instanceId: engine.startInstance(def.id) };
}

test('启动后分叉沿全部出边推进，汇合等待未决入口', () => {
  const { engine, instanceId } = setup();
  const status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('t1'), 'todo');
  assert.equal(status.get('tOther'), 'todo');
  assert.equal(status.get('j'), 'pending');
  assert.equal(status.get('tEnd'), 'pending');
});

test('一条已到、另一条未决时必须等待；后一条确定绕过后立即放行', () => {
  const { engine, instanceId } = setup();

  // t1=true：tA 支路激活，d1->j 的直达边被排除；j 仍需等待 tA
  engine.submitResult(instanceId, 't1', true);
  let status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('tA'), 'todo');
  assert.equal(status.get('j'), 'pending');
  assert.equal(status.get('tEnd'), 'pending');

  // tA 完成：j 的全部入口均已确定（一个到达、一个被排除），立即放行
  // 即使无关任务 tOther 仍无人处理
  engine.submitResult(instanceId, 'tA');
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j'), 'done');
  assert.equal(status.get('tEnd'), 'todo');
  assert.equal(status.get('tOther'), 'todo');
  assert.equal(engine.getStatus(instanceId).state, 'running');

  engine.submitResult(instanceId, 'tOther');
  engine.submitResult(instanceId, 'tEnd');
  const final = engine.getStatus(instanceId);
  assert.equal(final.state, 'completed');
  assert.deepEqual(
    executedSet(final),
    reachableSet(def, new Map([['t1', true]])),
  );
});

test('决策直接绕过时汇合立即放行，被绕过支路标记为不执行', () => {
  const { engine, instanceId } = setup();

  // t1=false：tA 被排除，d1->j 直达边到达，j 无需等待立即放行
  engine.submitResult(instanceId, 't1', false);
  const status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('tA'), 'skipped');
  assert.equal(status.get('j'), 'done');
  assert.equal(status.get('tEnd'), 'todo');
  assert.equal(status.get('tOther'), 'todo');

  engine.submitResult(instanceId, 'tOther');
  engine.submitResult(instanceId, 'tEnd');
  const final = engine.getStatus(instanceId);
  assert.equal(final.state, 'completed');
  assert.deepEqual(executedSet(final), reachableSet(def, new Map([['t1', false]])));
  assert.deepEqual(skippedSet(final), new Set(['tA']));
});

test('只接受当前待办任务的结果，重复提交不重复推进', () => {
  const { engine, instanceId } = setup();
  engine.submitResult(instanceId, 't1', true);

  // 未激活的任务不接受
  assert.throws(() => engine.submitResult(instanceId, 'tEnd'), WorkflowError);
  // 重复提交同一任务：拒绝且不重复推进
  assert.throws(() => engine.submitResult(instanceId, 't1', true), WorkflowError);
  let status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('tA'), 'todo');
  assert.equal(status.get('j'), 'pending');

  engine.submitResult(instanceId, 'tA');
  // tA 完成后重复提交：j 与 tEnd 不会再次激活
  assert.throws(() => engine.submitResult(instanceId, 'tA'), WorkflowError);
  status = statusMap(engine.getStatus(instanceId));
  assert.equal(status.get('j'), 'done');
  assert.equal(status.get('tEnd'), 'todo');
});

test('紧接决策网关的任务必须提交布尔结果', () => {
  const { engine, instanceId } = setup();
  assert.throws(() => engine.submitResult(instanceId, 't1', 'yes'), WorkflowError);
  // 提交失败后任务仍处于待办，可重新提交合法结果
  assert.equal(statusMap(engine.getStatus(instanceId)).get('t1'), 'todo');
  engine.submitResult(instanceId, 't1', true);
  assert.equal(statusMap(engine.getStatus(instanceId)).get('tA'), 'todo');
});

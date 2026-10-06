import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine, WorkflowError, DefinitionError } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';
import { executedSet, reachableSet, statusMap } from './helpers.ts';

test('线性流程：状态推进与完成判定', () => {
  const engine = new WorkflowEngine();
  engine.defineWorkflow({
    id: 'linear',
    entry: 'a',
    nodes: [
      { id: 'a', kind: 'task' },
      { id: 'b', kind: 'task' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  const inst = engine.startInstance('linear');
  let status = engine.getStatus(inst);
  assert.equal(status.state, 'running');
  assert.deepEqual(statusMap(status), new Map([
    ['a', 'todo'],
    ['b', 'pending'],
  ]));

  engine.submitResult(inst, 'a');
  engine.submitResult(inst, 'b');
  status = engine.getStatus(inst);
  assert.equal(status.state, 'completed');
});

test('并行分叉与汇合：汇合等待全部实际入口到齐', () => {
  const engine = new WorkflowEngine();
  engine.defineWorkflow({
    id: 'parallel',
    entry: 'f',
    nodes: [
      { id: 'f', kind: 'fork' },
      { id: 'a', kind: 'task' },
      { id: 'b', kind: 'task' },
      { id: 'j', kind: 'join' },
      { id: 'c', kind: 'task' },
    ],
    edges: [
      { from: 'f', to: 'a' },
      { from: 'f', to: 'b' },
      { from: 'a', to: 'j' },
      { from: 'b', to: 'j' },
      { from: 'j', to: 'c' },
    ],
  });
  const inst = engine.startInstance('parallel');
  engine.submitResult(inst, 'a');
  let status = statusMap(engine.getStatus(inst));
  assert.equal(status.get('j'), 'pending');
  assert.equal(status.get('c'), 'pending');
  engine.submitResult(inst, 'b');
  status = statusMap(engine.getStatus(inst));
  assert.equal(status.get('j'), 'done');
  assert.equal(status.get('c'), 'todo');
});

test('定义校验与实例隔离', () => {
  const engine = new WorkflowEngine();
  const def: WorkflowDefinition = {
    id: 'w',
    entry: 'a',
    nodes: [{ id: 'a', kind: 'task' }],
    edges: [],
  };
  engine.defineWorkflow(def);
  assert.throws(() => engine.defineWorkflow(def), DefinitionError);
  assert.throws(() => engine.startInstance('nope'), WorkflowError);

  const i1 = engine.startInstance('w');
  const i2 = engine.startInstance('w');
  engine.submitResult(i1, 'a');
  assert.equal(engine.getStatus(i1).state, 'completed');
  assert.equal(engine.getStatus(i2).state, 'running');
  assert.throws(() => engine.getStatus('nope'), WorkflowError);
});

test('实例启动后定义对象被外部修改不影响实例', () => {
  const engine = new WorkflowEngine();
  const def: WorkflowDefinition = {
    id: 'w',
    entry: 'a',
    nodes: [
      { id: 'a', kind: 'task' },
      { id: 'b', kind: 'task' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };
  engine.defineWorkflow(def);
  def.edges.push({ from: 'b', to: 'a' });
  def.nodes.push({ id: 'evil', kind: 'task' });
  const inst = engine.startInstance('w');
  engine.submitResult(inst, 'a');
  engine.submitResult(inst, 'b');
  const status = engine.getStatus(inst);
  assert.equal(status.state, 'completed');
  assert.deepEqual([...statusMap(status).keys()].sort(), ['a', 'b']);
});

/**
 * 复杂图：条件支路、并行分叉、交叉汇合、决策绕过汇合后再进入其他汇合。
 *   f0 -> t1, t4
 *   t1 -> d1;  d1 -T-> tA -> j1;  d1 -F-> tB -> j1
 *   j1 -> tC -> d2;  d2 -T-> tD -> j2;  d2 -F-> j2   (绕过 tD)
 *   t4 -> j2                                          (交叉汇合的另一入口)
 *   j2 -> tEnd
 */
const complexDef: WorkflowDefinition = {
  id: 'complex',
  entry: 'f0',
  nodes: [
    { id: 'f0', kind: 'fork' },
    { id: 't1', kind: 'task' },
    { id: 't4', kind: 'task' },
    { id: 'd1', kind: 'decision' },
    { id: 'tA', kind: 'task' },
    { id: 'tB', kind: 'task' },
    { id: 'j1', kind: 'join' },
    { id: 'tC', kind: 'task' },
    { id: 'd2', kind: 'decision' },
    { id: 'tD', kind: 'task' },
    { id: 'j2', kind: 'join' },
    { id: 'tEnd', kind: 'task' },
  ],
  edges: [
    { from: 'f0', to: 't1' },
    { from: 'f0', to: 't4' },
    { from: 't1', to: 'd1' },
    { from: 'd1', to: 'tA', condition: true },
    { from: 'd1', to: 'tB', condition: false },
    { from: 'tA', to: 'j1' },
    { from: 'tB', to: 'j1' },
    { from: 'j1', to: 'tC' },
    { from: 'tC', to: 'd2' },
    { from: 'd2', to: 'tD', condition: true },
    { from: 'd2', to: 'j2', condition: false },
    { from: 'tD', to: 'j2' },
    { from: 't4', to: 'j2' },
    { from: 'j2', to: 'tEnd' },
  ],
};

for (const r1 of [true, false]) {
  for (const r2 of [true, false]) {
    test(`复杂图全组合 [d1=${r1}, d2=${r2}]：实际执行集合与可达集合一致`, () => {
      const engine = new WorkflowEngine();
      engine.defineWorkflow(complexDef);
      const inst = engine.startInstance(complexDef.id);
      const results = new Map([
        ['t1', r1],
        ['tC', r2],
      ]);

      // 每次提交后：所有无需人工结果的推进均已生效
      engine.submitResult(inst, 't1', r1);
      let status = statusMap(engine.getStatus(inst));
      assert.equal(status.get(r1 ? 'tA' : 'tB'), 'todo');
      assert.equal(status.get(r1 ? 'tB' : 'tA'), 'skipped');
      assert.equal(status.get('j1'), 'pending');

      engine.submitResult(inst, r1 ? 'tA' : 'tB');
      status = statusMap(engine.getStatus(inst));
      assert.equal(status.get('j1'), 'done');
      assert.equal(status.get('tC'), 'todo');

      engine.submitResult(inst, 'tC', r2);
      status = statusMap(engine.getStatus(inst));
      if (r2) {
        assert.equal(status.get('tD'), 'todo');
        assert.equal(status.get('j2'), 'pending');
        engine.submitResult(inst, 'tD');
      } else {
        // 决策支路绕过 tD 直接进入 j2
        assert.equal(status.get('tD'), 'skipped');
      }
      // j2 仍等待无关支路上的 t4
      status = statusMap(engine.getStatus(inst));
      assert.equal(status.get('j2'), 'pending');
      assert.equal(status.get('tEnd'), 'pending');

      engine.submitResult(inst, 't4');
      status = statusMap(engine.getStatus(inst));
      assert.equal(status.get('j2'), 'done');
      assert.equal(status.get('tEnd'), 'todo');

      engine.submitResult(inst, 'tEnd');
      const final = engine.getStatus(inst);
      assert.equal(final.state, 'completed');

      // 最终实际执行节点 == 按已提交布尔结果选路后从入口推导的可达集合
      assert.deepEqual(executedSet(final), reachableSet(complexDef, results));
      // 每个节点都有确定状态：done 或 skipped，无残留 pending/todo
      for (const node of final.nodes) {
        assert.ok(node.status === 'done' || node.status === 'skipped');
      }
    });
  }
}

test('重复提交不会使分叉、汇合和下游任务再次激活', () => {
  const engine = new WorkflowEngine();
  engine.defineWorkflow({
    id: 'dup',
    entry: 't',
    nodes: [
      { id: 't', kind: 'task' },
      { id: 'f', kind: 'fork' },
      { id: 'a', kind: 'task' },
      { id: 'b', kind: 'task' },
      { id: 'j', kind: 'join' },
      { id: 'c', kind: 'task' },
    ],
    edges: [
      { from: 't', to: 'f' },
      { from: 'f', to: 'a' },
      { from: 'f', to: 'b' },
      { from: 'a', to: 'j' },
      { from: 'b', to: 'j' },
      { from: 'j', to: 'c' },
    ],
  });
  const inst = engine.startInstance('dup');
  engine.submitResult(inst, 't');
  // 分叉已推进，重复提交被拒绝且不会再次激活 a/b
  assert.throws(() => engine.submitResult(inst, 't'), WorkflowError);
  let status = statusMap(engine.getStatus(inst));
  assert.equal(status.get('a'), 'todo');
  assert.equal(status.get('b'), 'todo');

  engine.submitResult(inst, 'a');
  engine.submitResult(inst, 'b');
  assert.equal(statusMap(engine.getStatus(inst)).get('c'), 'todo');
  // 汇合放行后重复提交 a/b：j 与 c 不会再次激活
  assert.throws(() => engine.submitResult(inst, 'a'), WorkflowError);
  assert.throws(() => engine.submitResult(inst, 'b'), WorkflowError);
  status = statusMap(engine.getStatus(inst));
  assert.equal(status.get('j'), 'done');
  assert.equal(status.get('c'), 'todo');

  engine.submitResult(inst, 'c');
  assert.equal(engine.getStatus(inst).state, 'completed');
});

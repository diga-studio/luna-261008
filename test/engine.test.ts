import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InstanceStatus,
  WorkflowDefinition,
  WorkflowEngine,
} from '../src/index';

function sorted(list: string[]): string[] {
  return [...list].sort();
}

/**
 * 场景 1：两条条件支路通向同一汇合。
 *
 *   F(fork) ─→ T1(task) ─→ D1(decision)
 *   F      ─→ T2(task) ─→ D2(decision)
 *   F      ─→ U(task)   （无关任务，始终无人处理）
 *   D1.true  ─→ J(join)   D1.false ─→ X1(task)（旁路）
 *   D2.true  ─→ J         D2.false ─→ X2(task)（旁路）
 *   J ─→ E(task)
 */
function scenario1Definition(): WorkflowDefinition {
  return {
    id: 'scenario-1',
    entry: 'F',
    nodes: [
      { id: 'F', kind: 'fork', outgoing: ['T1', 'T2', 'U'] },
      { id: 'T1', kind: 'task', outgoing: ['D1'] },
      { id: 'D1', kind: 'decision', onTrue: 'J', onFalse: 'X1' },
      { id: 'T2', kind: 'task', outgoing: ['D2'] },
      { id: 'D2', kind: 'decision', onTrue: 'J', onFalse: 'X2' },
      { id: 'X1', kind: 'task', outgoing: [] },
      { id: 'X2', kind: 'task', outgoing: [] },
      { id: 'J', kind: 'join', outgoing: ['E'] },
      { id: 'E', kind: 'task', outgoing: [] },
      { id: 'U', kind: 'task', outgoing: [] },
    ],
  };
}

test('场景1：一条支路已到、另一条未决时汇合等待；另一条确定绕过后立即放行', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition(scenario1Definition());
  const instanceId = engine.startInstance('scenario-1');

  let status = engine.getInstanceStatus(instanceId);
  assert.deepEqual(sorted(status.todoTasks), ['T1', 'T2', 'U']);
  assert.deepEqual(status.completedNodes, ['F']);
  assert.equal(status.state, 'running');

  // T1=true：D1.true 直达 J（一条入口已到），但 D2 支路未决，J 必须等待
  status = engine.submitTaskResult(instanceId, 'T1', true);
  assert.deepEqual(sorted(status.todoTasks), ['T2', 'U']);
  assert.deepEqual(sorted(status.completedNodes), ['D1', 'F', 'T1']);
  assert.deepEqual(status.excludedNodes, ['X1']);
  assert.ok(status.pendingNodes.includes('E'), 'J 未放行，E 不应激活');

  // T2=false：D2 确定绕过 J，J 的另一入口被排除，立即放行，即使 U 仍无人处理
  status = engine.submitTaskResult(instanceId, 'T2', false);
  assert.deepEqual(sorted(status.todoTasks), ['E', 'U', 'X2']);
  assert.deepEqual(sorted(status.completedNodes), ['D1', 'D2', 'F', 'J', 'T1', 'T2']);
  assert.equal(status.state, 'running');

  // 收尾：提交 E 与 X2；U 始终未提交，实例不能算完成
  status = engine.submitTaskResult(instanceId, 'E', true);
  status = engine.submitTaskResult(instanceId, 'X2', true);
  assert.equal(status.state, 'running', 'U 未提交，实例不应完成');
  status = engine.submitTaskResult(instanceId, 'U', false);
  assert.equal(status.state, 'completed');
  assert.deepEqual(status.todoTasks, []);
  assert.deepEqual(status.excludedNodes, ['X1']);

  // 实际执行节点 = 按已提交布尔结果（T1=true, T2=false）从入口推导的可达集合
  assert.deepEqual(
    sorted(status.completedNodes),
    ['D1', 'D2', 'E', 'F', 'J', 'T1', 'T2', 'U', 'X2'],
  );
  assert.equal(new Set(status.completedNodes).size, status.completedNodes.length);
});

test('场景1变体：先到的支路被排除时，汇合等另一条支路实际到达', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition(scenario1Definition());
  const instanceId = engine.startInstance('scenario-1');

  // T1=false：D1 绕过 J 走向 X1；J 的 D1 入口被排除，等待 D2 支路
  let status = engine.submitTaskResult(instanceId, 'T1', false);
  assert.deepEqual(sorted(status.todoTasks), ['T2', 'U', 'X1']);
  assert.ok(status.pendingNodes.includes('J') || status.todoTasks.includes('T2'));

  // T2=true：D2.true 到达 J，J 放行
  status = engine.submitTaskResult(instanceId, 'T2', true);
  assert.deepEqual(sorted(status.todoTasks), ['E', 'U', 'X1']);
  assert.ok(status.completedNodes.includes('J'));
  assert.ok(status.excludedNodes.includes('X2'), 'X2 被 D2 排除');
});

/**
 * 场景 2：全部入口被排除后的连续传播 + 下游交叉汇合仍从其他支路获得输入。
 *
 *   F(fork) ─→ A(task) ─→ D1(decision)
 *   F      ─→ G(task)
 *   D1.true  ─→ B(task) ─→ D2(decision)
 *   D1.false ─→ H(task) （旁路）
 *   D2.true  ─→ J1(join)
 *   D2.false ─→ J2(join) （决策支路绕过 J1 直接进入其他汇合）
 *   J1 ─→ J2
 *   G  ─→ J2
 *   J2 ─→ E(task)
 */
function scenario2Definition(): WorkflowDefinition {
  return {
    id: 'scenario-2',
    entry: 'F',
    nodes: [
      { id: 'F', kind: 'fork', outgoing: ['A', 'G'] },
      { id: 'A', kind: 'task', outgoing: ['D1'] },
      { id: 'D1', kind: 'decision', onTrue: 'B', onFalse: 'H' },
      { id: 'B', kind: 'task', outgoing: ['D2'] },
      { id: 'D2', kind: 'decision', onTrue: 'J1', onFalse: 'J2' },
      { id: 'H', kind: 'task', outgoing: [] },
      { id: 'J1', kind: 'join', outgoing: ['J2'] },
      { id: 'G', kind: 'task', outgoing: ['J2'] },
      { id: 'J2', kind: 'join', outgoing: ['E'] },
      { id: 'E', kind: 'task', outgoing: [] },
    ],
  };
}

test('场景2：汇合全部入口被排除后连续传播，下游交叉汇合仍从其他支路获得输入', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition(scenario2Definition());
  const instanceId = engine.startInstance('scenario-2');

  let status = engine.submitTaskResult(instanceId, 'A', true);
  assert.deepEqual(sorted(status.todoTasks), ['B', 'G']);
  assert.ok(status.excludedNodes.includes('H'), 'H 被 D1 排除');

  // B=false：D2 绕过 J1 直达 J2；J1 唯一入口被排除 → J1 排除并传播到 J2 的对应入口，
  // 无需提交任何虚构任务结果；J2 仍有 G 的实际入口，不能被一并跳过
  status = engine.submitTaskResult(instanceId, 'B', false);
  assert.ok(status.excludedNodes.includes('J1'), 'J1 全部入口被排除，自身不执行');
  assert.deepEqual(sorted(status.todoTasks), ['G'], 'J2 等待 G，E 尚未激活');
  assert.ok(!status.excludedNodes.includes('J2'), 'J2 仍有实际入口，不能跳过');
  assert.ok(!status.excludedNodes.includes('E'));

  // G 到达后 J2 放行
  status = engine.submitTaskResult(instanceId, 'G', true);
  assert.deepEqual(status.todoTasks, ['E']);
  assert.ok(status.completedNodes.includes('J2'));

  status = engine.submitTaskResult(instanceId, 'E', true);
  assert.equal(status.state, 'completed');

  // 实际执行节点 = 按已提交布尔结果（A=true, B=false）从入口推导的可达集合
  assert.deepEqual(
    sorted(status.completedNodes),
    ['A', 'B', 'D1', 'D2', 'E', 'F', 'G', 'J2'],
  );
  assert.deepEqual(sorted(status.excludedNodes), ['H', 'J1']);
  assert.equal(new Set(status.completedNodes).size, status.completedNodes.length);
});

test('并行分叉沿全部出边推进，汇合等待全部实际入口', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition({
    id: 'parallel',
    entry: 'F',
    nodes: [
      { id: 'F', kind: 'fork', outgoing: ['P', 'Q'] },
      { id: 'P', kind: 'task', outgoing: ['J'] },
      { id: 'Q', kind: 'task', outgoing: ['J'] },
      { id: 'J', kind: 'join', outgoing: ['R'] },
      { id: 'R', kind: 'task', outgoing: [] },
    ],
  });
  const instanceId = engine.startInstance('parallel');

  let status = engine.getInstanceStatus(instanceId);
  assert.deepEqual(sorted(status.todoTasks), ['P', 'Q']);

  status = engine.submitTaskResult(instanceId, 'P', true);
  assert.deepEqual(status.todoTasks, ['Q'], 'Q 未提交，J 必须等待');

  status = engine.submitTaskResult(instanceId, 'Q', false);
  assert.deepEqual(status.todoTasks, ['R']);

  status = engine.submitTaskResult(instanceId, 'R', true);
  assert.equal(status.state, 'completed');
  assert.deepEqual(sorted(status.completedNodes), ['F', 'J', 'P', 'Q', 'R']);
});

test('只接受当前待办任务的结果；重复提交不重复推进', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition({
    id: 'dup',
    entry: 'F',
    nodes: [
      { id: 'F', kind: 'fork', outgoing: ['A'] },
      { id: 'A', kind: 'task', outgoing: ['D'] },
      { id: 'D', kind: 'decision', onTrue: 'B', onFalse: 'C' },
      { id: 'B', kind: 'task', outgoing: [] },
      { id: 'C', kind: 'task', outgoing: [] },
    ],
  });
  const instanceId = engine.startInstance('dup');

  // 非待办任务：拒绝
  assert.throws(() => engine.submitTaskResult(instanceId, 'B', true), /not currently todo/);
  // 未知节点：拒绝
  assert.throws(() => engine.submitTaskResult(instanceId, 'ZZZ', true));

  const before = engine.submitTaskResult(instanceId, 'A', true);
  assert.deepEqual(before.todoTasks, ['B']);
  assert.ok(before.excludedNodes.includes('C'));

  // 重复提交相同结果：拒绝，且不引起任何重复推进
  assert.throws(() => engine.submitTaskResult(instanceId, 'A', true), /not currently todo/);
  const after = engine.getInstanceStatus(instanceId);
  assert.deepEqual(after, before);
  assert.deepEqual(after.todoTasks, ['B']);
  assert.equal(
    after.completedNodes.filter((id) => id === 'D').length,
    1,
    '决策网关不能因重复提交再次激活',
  );
});

test('已完成的实例拒绝继续提交', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition({
    id: 'simple',
    entry: 'A',
    nodes: [{ id: 'A', kind: 'task', outgoing: [] }],
  });
  const instanceId = engine.startInstance('simple');
  const status = engine.submitTaskResult(instanceId, 'A', true);
  assert.equal(status.state, 'completed');
  assert.throws(() => engine.submitTaskResult(instanceId, 'A', true), /already completed/);
});

test('定义校验：环、多入口、未知目标、决策位置、重复注册', () => {
  const engine = new WorkflowEngine();

  // 环
  assert.throws(
    () =>
      engine.registerDefinition({
        id: 'cycle',
        entry: 'S',
        nodes: [
          { id: 'S', kind: 'task', outgoing: ['A'] },
          { id: 'A', kind: 'task', outgoing: ['B'] },
          { id: 'B', kind: 'task', outgoing: ['A'] },
        ],
      }),
    /cycle/,
  );

  // 非汇合节点多入口
  assert.throws(
    () =>
      engine.registerDefinition({
        id: 'multi-in',
        entry: 'F',
        nodes: [
          { id: 'F', kind: 'fork', outgoing: ['A', 'B'] },
          { id: 'A', kind: 'task', outgoing: ['C'] },
          { id: 'B', kind: 'task', outgoing: ['C'] },
          { id: 'C', kind: 'task', outgoing: [] },
        ],
      }),
    /only joins/,
  );

  // 未知目标
  assert.throws(
    () =>
      engine.registerDefinition({
        id: 'bad-target',
        entry: 'A',
        nodes: [{ id: 'A', kind: 'task', outgoing: ['NOPE'] }],
      }),
    /unknown target/,
  );

  // 决策未紧接人工任务
  assert.throws(
    () =>
      engine.registerDefinition({
        id: 'bad-decision',
        entry: 'F',
        nodes: [
          { id: 'F', kind: 'fork', outgoing: ['D'] },
          { id: 'D', kind: 'decision', onTrue: 'A', onFalse: 'B' },
          { id: 'A', kind: 'task', outgoing: [] },
          { id: 'B', kind: 'task', outgoing: [] },
        ],
      }),
    /must directly follow a task/,
  );

  // 重复注册
  const def: WorkflowDefinition = {
    id: 'once',
    entry: 'A',
    nodes: [{ id: 'A', kind: 'task', outgoing: [] }],
  };
  engine.registerDefinition(def);
  assert.throws(() => engine.registerDefinition(def), /duplicate workflow definition/);

  // 未知定义 / 未知实例
  assert.throws(() => engine.startInstance('missing'), /unknown workflow definition/);
  assert.throws(() => engine.getInstanceStatus('missing'), /unknown instance/);
});

test('同一定义的多个实例互不影响', () => {
  const engine = new WorkflowEngine();
  engine.registerDefinition({
    id: 'multi',
    entry: 'A',
    nodes: [
      { id: 'A', kind: 'task', outgoing: ['D'] },
      { id: 'D', kind: 'decision', onTrue: 'B', onFalse: 'C' },
      { id: 'B', kind: 'task', outgoing: [] },
      { id: 'C', kind: 'task', outgoing: [] },
    ],
  });
  const i1 = engine.startInstance('multi');
  const i2 = engine.startInstance('multi');
  assert.notEqual(i1, i2);

  const s1 = engine.submitTaskResult(i1, 'A', true);
  assert.deepEqual(s1.todoTasks, ['B']);

  const s2 = engine.getInstanceStatus(i2);
  assert.deepEqual(s2.todoTasks, ['A'], 'i2 不受 i1 提交影响');
});

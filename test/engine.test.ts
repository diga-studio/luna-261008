import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalEngine, ApplicationView } from '../src';

let seq = 0;
function newEngine(): { engine: ApprovalEngine; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  const file = path.join(dir, `data-${seq++}.json`);
  return { engine: new ApprovalEngine(file), file };
}

function pendingOf(view: ApplicationView, assignee?: string) {
  return view.todos.filter(
    (t) => t.status === 'PENDING' && (assignee === undefined || t.assignee === assignee),
  );
}

test('基本流程：两级 ALL 链依次通过后完成，完成后拒绝动作', () => {
  const { engine } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'ops', approvers: ['a', 'b'], mode: 'ALL' },
      { key: 'finance', approvers: ['c'], mode: 'ALL' },
    ],
  });
  const appId = engine.createApplication('refund');
  let view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'ops');
  assert.equal(pendingOf(view).length, 2);

  const [ta, tb] = pendingOf(view);
  assert.equal(engine.approve(ta.id, ta.assignee, 'op-a').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'ops', '一人同意后 ALL 节点不通过');

  assert.equal(engine.approve(tb.id, tb.assignee, 'op-b').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'finance');
  const [tc] = pendingOf(view);
  assert.equal(tc.assignee, 'c');

  assert.equal(engine.approve(tc.id, 'c', 'op-c').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.currentNodeIndex, null);
  assert.equal(pendingOf(view).length, 0);
  // 完成后不再接受动作
  assert.equal(engine.approve(tc.id, 'c', 'op-c2').code, 'TODO_INVALID');
});

test('退回重审：旧同意与旧加签失效，重放退回不再执行', () => {
  const { engine } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'n0', approvers: ['alice', 'bob'], mode: 'ALL' },
      { key: 'n1', approvers: ['carol'], mode: 'ANY' },
    ],
  });
  const appId = engine.createApplication('refund');
  let view = engine.getApplication(appId);
  const [oldAlice, oldBob] = ['alice', 'bob'].map(
    (u) => pendingOf(view, u)[0],
  );
  assert.equal(engine.approve(oldAlice.id, 'alice', 'op-1').code, 'OK');
  assert.equal(engine.approve(oldBob.id, 'bob', 'op-2').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'n1');
  const carolTodo = pendingOf(view, 'carol')[0];

  // carol 退回到 n0
  assert.equal(engine.sendBack(carolTodo.id, 'carol', 'op-back', 0).code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'n0');
  // 新一轮待办是全新的 id
  const newAlice = pendingOf(view, 'alice')[0];
  const newBob = pendingOf(view, 'bob')[0];
  assert.notEqual(newAlice.id, oldAlice.id);
  assert.equal(pendingOf(view).length, 2);
  // 旧待办不再有效且可查询区分：已处理的保留历史状态，未处理的失效
  assert.equal(view.todos.find((t) => t.id === oldAlice.id)?.status, 'APPROVED');
  assert.equal(view.todos.find((t) => t.id === carolTodo.id)?.status, 'INVALIDATED');

  // 延迟到达的旧同意（新操作标识）返回失效，不改变状态
  assert.equal(engine.approve(oldAlice.id, 'alice', 'op-late-1').code, 'TODO_INVALID');
  // 延迟到达的旧加签同样失效
  assert.equal(engine.addSign(oldBob.id, 'bob', 'op-late-2', 'mallory').code, 'TODO_INVALID');
  view = engine.getApplication(appId);
  assert.equal(pendingOf(view).length, 2, '旧操作不能改变新一轮状态');
  assert.equal(pendingOf(view, 'mallory').length, 0);

  // 重放已成功的退回操作：返回首次结果，不再退回一次
  const before = engine.listDecisions(appId).length;
  const replay = engine.sendBack(carolTodo.id, 'carol', 'op-back', 0);
  assert.equal(replay.code, 'OK');
  assert.equal(replay.replayed, true);
  assert.equal(engine.listDecisions(appId).length, before, '重放不产生新决定');
  view = engine.getApplication(appId);
  assert.equal(view.todos.filter((t) => t.nodeIndex === 0 && t.status === 'PENDING').length, 2);

  // 同一个人再次收到待办，必须重新同意
  assert.equal(engine.approve(newAlice.id, 'alice', 'op-3').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'n0', '只有 alice 重新同意，ALL 不通过');
  assert.equal(engine.approve(newBob.id, 'bob', 'op-4').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'n1');
  const carolTodo2 = pendingOf(view, 'carol')[0];
  assert.notEqual(carolTodo2.id, carolTodo.id);
  assert.equal(engine.approve(carolTodo2.id, 'carol', 'op-5').code, 'OK');
  assert.equal(engine.getApplication(appId).status, 'COMPLETED');
});

test('版本隔离：旧申请退回重审仍用旧名单与通过方式，新申请用新版本', () => {
  const { engine } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'n0', approvers: ['u1', 'u2'], mode: 'ANY' },
      { key: 'n1', approvers: ['u3'], mode: 'ALL' },
    ],
  });
  const app1 = engine.createApplication('refund');
  // 申请运行中发布新版本
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'n0', approvers: ['u9'], mode: 'ALL' },
      { key: 'n1', approvers: ['u8'], mode: 'ALL' },
    ],
  });

  // ANY：一个同意即通过，剩余待办立即失效
  let view = engine.getApplication(app1);
  const t1 = pendingOf(view, 'u1')[0];
  const t2 = pendingOf(view, 'u2')[0];
  assert.equal(engine.approve(t1.id, 'u1', 'op-1').code, 'OK');
  view = engine.getApplication(app1);
  assert.equal(view.currentNodeKey, 'n1');
  assert.equal(view.todos.find((t) => t.id === t2.id)?.status, 'INVALIDATED');
  // 迟到提交不能推进下一节点
  assert.equal(engine.approve(t2.id, 'u2', 'op-late').code, 'TODO_INVALID');
  view = engine.getApplication(app1);
  assert.equal(view.currentNodeKey, 'n1');
  assert.equal(pendingOf(view, 'u3').length, 1);

  // 旧申请退回重审：仍按 v1 的原始名单与 ANY 方式
  const t3 = pendingOf(view, 'u3')[0];
  assert.equal(engine.sendBack(t3.id, 'u3', 'op-back', 0).code, 'OK');
  view = engine.getApplication(app1);
  assert.equal(view.currentNodeKey, 'n0');
  assert.equal(pendingOf(view, 'u1').length, 1, '旧版本名单 u1/u2');
  assert.equal(pendingOf(view, 'u2').length, 1);
  assert.equal(pendingOf(view, 'u9').length, 0, '不使用新版本名单');
  // 仍是 ANY：u2 一人同意即通过
  assert.equal(engine.approve(pendingOf(view, 'u2')[0].id, 'u2', 'op-2').code, 'OK');
  view = engine.getApplication(app1);
  assert.equal(view.currentNodeKey, 'n1');
  assert.equal(pendingOf(view, 'u3').length, 1, 'n1 也仍是旧名单 u3');

  // 新申请使用新版本
  const app2 = engine.createApplication('refund');
  const view2 = engine.getApplication(app2);
  assert.equal(view2.definitionVersion, 2);
  assert.equal(pendingOf(view2, 'u9').length, 1);
  assert.equal(pendingOf(view2, 'u1').length, 0);
});

test('加签：ALL 立即包含新加入者，ANY 条件不变，已有同意仍有效', () => {
  const { engine } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'all', approvers: ['a', 'b'], mode: 'ALL' },
      { key: 'any', approvers: ['c'], mode: 'ANY' },
    ],
  });
  const appId = engine.createApplication('refund');
  let view = engine.getApplication(appId);
  const ta = pendingOf(view, 'a')[0];
  const tb = pendingOf(view, 'b')[0];

  // a 先同意，再加签 x：已有同意仍有效，a 的待办已处理
  assert.equal(engine.approve(ta.id, 'a', 'op-1').code, 'OK');
  // b 加签 x，b 自己的待办仍待处理
  assert.equal(engine.addSign(tb.id, 'b', 'op-2', 'x').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(pendingOf(view, 'x').length, 1);
  assert.equal(pendingOf(view, 'b').length, 1, '执行加签者自己的待办仍待处理');
  // 重复加签已在名单中的用户不产生新待办
  assert.equal(engine.addSign(tb.id, 'b', 'op-3', 'a').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(pendingOf(view, 'a').length, 0, 'a 已在名单且已同意，不产生新待办');

  // ALL 的通过条件立即包含 x：b 同意后不通过
  assert.equal(engine.approve(tb.id, 'b', 'op-4').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'all');
  assert.equal(engine.approve(pendingOf(view, 'x')[0].id, 'x', 'op-5').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.currentNodeKey, 'any');

  // ANY 节点：c 加签 y 后条件不变，c 一人同意即通过，y 的待办失效
  const tc = pendingOf(view, 'c')[0];
  assert.equal(engine.addSign(tc.id, 'c', 'op-6', 'y').code, 'OK');
  assert.equal(engine.approve(tc.id, 'c', 'op-7').code, 'OK');
  view = engine.getApplication(appId);
  assert.equal(view.status, 'COMPLETED');
  const yTodo = view.todos.find((t) => t.assignee === 'y');
  assert.equal(yTodo?.status, 'INVALIDATED');
});

test('幂等：相同标识重试返回首次结果，不同标识重复同意不重复计票', () => {
  const { engine } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [{ key: 'n0', approvers: ['a', 'b'], mode: 'ALL' }],
  });
  const appId = engine.createApplication('refund');
  const view = engine.getApplication(appId);
  const ta = pendingOf(view, 'a')[0];

  const first = engine.approve(ta.id, 'a', 'op-same');
  assert.equal(first.code, 'OK');
  const retry = engine.approve(ta.id, 'a', 'op-same');
  assert.equal(retry.code, 'OK');
  assert.equal(retry.replayed, true);
  assert.equal(
    engine.listDecisions(appId).filter((d) => d.action === 'APPROVE').length,
    1,
    '重试不重复执行',
  );

  // 不同标识重复同意同一待办：待办已失效，不重复计票
  assert.equal(engine.approve(ta.id, 'a', 'op-other').code, 'TODO_INVALID');
  // 非审批人操作
  const tb = pendingOf(engine.getApplication(appId), 'b')[0];
  assert.equal(engine.approve(tb.id, 'a', 'op-x').code, 'NOT_ASSIGNEE');
  // 不存在的待办
  assert.equal(engine.approve('todo-404', 'a', 'op-y').code, 'TODO_INVALID');
  // b 正常同意后完成
  assert.equal(engine.approve(tb.id, 'b', 'op-z').code, 'OK');
  assert.equal(engine.getApplication(appId).status, 'COMPLETED');
});

test('持久化：关闭重开后申请状态与操作重试结果保持不变', () => {
  const { engine, file } = newEngine();
  engine.publishDefinition({
    id: 'refund',
    nodes: [
      { key: 'n0', approvers: ['a'], mode: 'ALL' },
      { key: 'n1', approvers: ['b'], mode: 'ANY' },
    ],
  });
  const appId = engine.createApplication('refund');
  const ta = pendingOf(engine.getApplication(appId), 'a')[0];
  assert.equal(engine.approve(ta.id, 'a', 'op-1').code, 'OK');

  // 模拟正常关闭并重新打开
  const reopened = new ApprovalEngine(file);
  const view = reopened.getApplication(appId);
  assert.equal(view.currentNodeKey, 'n1');
  assert.equal(view.status, 'RUNNING');
  // 操作重试结果保持
  const replay = reopened.approve(ta.id, 'a', 'op-1');
  assert.equal(replay.code, 'OK');
  assert.equal(replay.replayed, true);
  // 流程可继续
  const tb = pendingOf(view, 'b')[0];
  assert.equal(reopened.approve(tb.id, 'b', 'op-2').code, 'OK');
  assert.equal(reopened.getApplication(appId).status, 'COMPLETED');
});

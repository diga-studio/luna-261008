import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalService, Store, ApplicationView } from '../src';

function newService(): { svc: ApprovalService; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-'));
  const file = path.join(dir, 'state.json');
  return { svc: new ApprovalService(new Store(file)), file };
}

function pendingTasks(app: ApplicationView, nodeKey?: string) {
  return app.tasks.filter(
    (t) => t.status === 'pending' && (!nodeKey || t.nodeKey === nodeKey),
  );
}

test('全部同意：所有审批人同意后才进入下一节点，最后节点通过后完成', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'all' },
    { key: 'n2', approvers: ['c'], mode: 'all' },
  ]);
  const app = svc.submitApplication('def');
  assert.equal(app.status, 'running');
  assert.equal(app.currentNodeKey, 'n1');
  assert.deepEqual(
    pendingTasks(app).map((t) => t.assignee).sort(),
    ['a', 'b'],
  );

  const [ta, tb] = pendingTasks(app);
  svc.approve('op-1', ta.id, ta.assignee);
  // 只有一人同意，不推进
  assert.equal(svc.getApplication(app.id).currentNodeKey, 'n1');
  svc.approve('op-2', tb.id, tb.assignee);
  const after = svc.getApplication(app.id);
  assert.equal(after.currentNodeKey, 'n2');
  // n1 全部待办已不再是待办
  assert.equal(pendingTasks(after, 'n1').length, 0);

  const [tc] = pendingTasks(after, 'n2');
  svc.approve('op-3', tc.id, tc.assignee);
  const done = svc.getApplication(app.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.currentNodeKey, null);
});

test('任一同意：一个同意即通过，其余待办失效', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'any' },
    { key: 'n2', approvers: ['c'], mode: 'all' },
  ]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app, 'n1');
  svc.approve('op-1', ta.id, ta.assignee);
  const after = svc.getApplication(app.id);
  assert.equal(after.currentNodeKey, 'n2');
  const leftover = after.tasks.find((t) => t.nodeKey === 'n1' && t.assignee !== ta.assignee)!;
  assert.equal(leftover.status, 'invalid');
  // 迟到的提交返回失效，不改变状态
  const late = svc.approve('op-2', leftover.id, leftover.assignee);
  assert.deepEqual(late, { ok: false, reason: 'task_invalid' });
  assert.equal(svc.getApplication(app.id).currentNodeKey, 'n2');
});

test('只能处理自己的待办；已完成申请不再接受审批动作', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [{ key: 'n1', approvers: ['a'], mode: 'all' }]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app);
  const r1 = svc.approve('op-1', ta.id, 'someone-else');
  assert.equal(r1.ok, false);
  svc.approve('op-2', ta.id, 'a');
  assert.equal(svc.getApplication(app.id).status, 'completed');
  const r2 = svc.approve('op-3', ta.id, 'a');
  assert.deepEqual(r2, { ok: false, reason: 'task_invalid' });
});

test('加签：新成员产生待办并计入全部同意；重复加签不产生新待办；执行者待办仍待处理', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [{ key: 'n1', approvers: ['a'], mode: 'all' }]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app);
  const r = svc.addsign('op-1', ta.id, 'a', 'x');
  assert.deepEqual(r, { ok: true, type: 'signed' });
  let cur = svc.getApplication(app.id);
  // 执行者自己的待办仍待处理，x 有新待办
  assert.deepEqual(
    pendingTasks(cur).map((t) => t.assignee).sort(),
    ['a', 'x'],
  );
  // 重复加签同一人不产生新待办
  svc.addsign('op-2', ta.id, 'a', 'x');
  cur = svc.getApplication(app.id);
  assert.equal(pendingTasks(cur).length, 2);
  // a 同意后不通过，因为加签者 x 也算入全部同意
  svc.approve('op-3', ta.id, 'a');
  assert.equal(svc.getApplication(app.id).status, 'running');
  const tx = pendingTasks(svc.getApplication(app.id)).find((t) => t.assignee === 'x')!;
  svc.approve('op-4', tx.id, 'x');
  assert.equal(svc.getApplication(app.id).status, 'completed');
});

test('任一同意模式下加签不改变通过条件', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [{ key: 'n1', approvers: ['a'], mode: 'any' }]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app);
  svc.addsign('op-1', ta.id, 'a', 'x');
  svc.approve('op-2', ta.id, 'a');
  assert.equal(svc.getApplication(app.id).status, 'completed');
});

test('相同操作标识重试返回首次结果；不同标识重复同意不重复计票', () => {
  const { svc } = newService();
  svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'all' },
    { key: 'n2', approvers: ['c'], mode: 'all' },
  ]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app).filter((t) => t.assignee === 'a');
  const first = svc.approve('op-1', ta.id, 'a');
  // 相同标识重试：即使后续状态变化也返回首次结果
  const retry = svc.approve('op-1', ta.id, 'a');
  assert.deepEqual(retry, first);
  // 不同标识重复同意同一待办：不重复计票（b 未同意，不能推进）
  const dup = svc.approve('op-2', ta.id, 'a');
  assert.equal(dup.ok, false);
  assert.equal(svc.getApplication(app.id).currentNodeKey, 'n1');
  assert.equal(
    svc.getApplication(app.id).decisions.filter((d) => d.action === 'approve').length,
    1,
  );
});

test('关闭重开后申请状态与操作重试结果保持不变', () => {
  const { svc, file } = newService();
  svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'any' },
    { key: 'n2', approvers: ['c'], mode: 'all' },
  ]);
  const app = svc.submitApplication('def');
  const [ta] = pendingTasks(app, 'n1');
  const first = svc.approve('op-1', ta.id, 'a');

  const reopened = new ApprovalService(new Store(file));
  const view = reopened.getApplication(app.id);
  assert.equal(view.currentNodeKey, 'n2');
  assert.equal(view.tasks.length, app.tasks.length + 1);
  // 重试已执行过的操作，返回首次结果，不再执行
  const retry = reopened.approve('op-1', ta.id, 'a');
  assert.deepEqual(retry, first);
  assert.equal(
    reopened.getApplication(app.id).decisions.filter((d) => d.action === 'approve').length,
    1,
  );
  // 重开后流程可继续
  const [tc] = pendingTasks(view, 'n2');
  reopened.approve('op-2', tc.id, 'c');
  assert.equal(reopened.getApplication(app.id).status, 'completed');
});

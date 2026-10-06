import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalService, Store, ApplicationView } from '../src';

function newService(): ApprovalService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-'));
  return new ApprovalService(new Store(path.join(dir, 'state.json')));
}

function pending(app: ApplicationView, nodeKey: string) {
  return app.tasks.filter((t) => t.status === 'pending' && t.nodeKey === nodeKey);
}

// 场景：运行中发布新版本，旧申请退回重审仍用旧名单和通过方式，新申请用新版本；
// 任一同意通过后剩余待办失效，迟到提交不能推进下一节点。
test('版本隔离：旧申请始终按发起版本运行，新申请使用新版本', () => {
  const svc = newService();
  const v1 = svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'any' },
    { key: 'n2', approvers: ['c'], mode: 'all' },
  ]);
  assert.equal(v1.version, 1);

  // 旧申请按 v1 发起
  const app1 = svc.submitApplication('def');
  assert.equal(app1.version, 1);

  // 运行中发布 v2：n1 改为全部同意，n2 改为两人
  const v2 = svc.publishDefinition('def', [
    { key: 'n1', approvers: ['a', 'b'], mode: 'all' },
    { key: 'n2', approvers: ['c', 'd'], mode: 'all' },
  ]);
  assert.equal(v2.version, 2);

  // 新申请使用 v2：n1 是全部同意，a 一人同意不能通过
  const app2 = svc.submitApplication('def');
  assert.equal(app2.version, 2);
  const app2Ta = pending(app2, 'n1').find((t) => t.assignee === 'a')!;
  svc.approve('op2-a', app2Ta.id, 'a');
  assert.equal(svc.getApplication(app2.id).currentNodeKey, 'n1');
  const app2Tb = pending(svc.getApplication(app2.id), 'n1').find((t) => t.assignee === 'b')!;
  svc.approve('op2-b', app2Tb.id, 'b');
  const app2After = svc.getApplication(app2.id);
  assert.equal(app2After.currentNodeKey, 'n2');
  assert.deepEqual(
    pending(app2After, 'n2').map((t) => t.assignee).sort(),
    ['c', 'd'],
  );

  // 旧申请 app1 仍按 v1：n1 任一同意，a 同意即通过，b 的待办失效
  const app1Ta = pending(svc.getApplication(app1.id), 'n1').find((t) => t.assignee === 'a')!;
  svc.approve('op1-a', app1Ta.id, 'a');
  let cur1 = svc.getApplication(app1.id);
  assert.equal(cur1.currentNodeKey, 'n2');
  const app1TbOld = cur1.tasks.find((t) => t.nodeKey === 'n1' && t.assignee === 'b')!;
  assert.equal(app1TbOld.status, 'invalid');

  // 迟到提交不能推进下一节点：b 的旧待办提交失效，n2 仍只有 c 的待办
  const late = svc.approve('op1-late-b', app1TbOld.id, 'b');
  assert.deepEqual(late, { ok: false, reason: 'task_invalid' });
  cur1 = svc.getApplication(app1.id);
  assert.equal(cur1.currentNodeKey, 'n2');
  assert.deepEqual(pending(cur1, 'n2').map((t) => t.assignee), ['c']);
  assert.equal(cur1.decisions.filter((d) => d.action === 'approve').length, 1);

  // 旧申请退回重审：仍用 v1 的名单（a,b）和通过方式（任一同意）
  const tc = pending(cur1, 'n2')[0];
  svc.returnTo('op1-ret', tc.id, 'c', 'n1');
  cur1 = svc.getApplication(app1.id);
  assert.equal(cur1.currentNodeKey, 'n1');
  assert.deepEqual(
    pending(cur1, 'n1').map((t) => t.assignee).sort(),
    ['a', 'b'],
  );
  // 仍是任一同意：b 一人同意即通过；若是新版本的全部同意则不会通过
  const tb2 = pending(cur1, 'n1').find((t) => t.assignee === 'b')!;
  svc.approve('op1-b2', tb2.id, 'b');
  cur1 = svc.getApplication(app1.id);
  assert.equal(cur1.currentNodeKey, 'n2');
  // 退回后重进 n2，也仍按 v1 的名单（只有 c）
  assert.deepEqual(pending(cur1, 'n2').map((t) => t.assignee), ['c']);
});

test('同一定义多次发布版本号递增，查询视图携带版本信息', () => {
  const svc = newService();
  svc.publishDefinition('def', [{ key: 'n1', approvers: ['a'], mode: 'all' }]);
  svc.publishDefinition('def', [{ key: 'n1', approvers: ['b'], mode: 'all' }]);
  const v3 = svc.publishDefinition('def', [{ key: 'n1', approvers: ['c'], mode: 'all' }]);
  assert.equal(v3.version, 3);
  const app = svc.submitApplication('def');
  assert.equal(app.version, 3);
  assert.deepEqual(pending(app, 'n1').map((t) => t.assignee), ['c']);
});

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const src_1 = require("../src");
function newService() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-'));
    return new src_1.ApprovalService(new src_1.Store(path.join(dir, 'state.json')));
}
function pending(app, nodeKey) {
    return app.tasks.filter((t) => t.status === 'pending' && t.nodeKey === nodeKey);
}
// 场景：后续节点退回前一节点后，旧同意/旧加签不能影响新一轮；
// 同一人必须重新同意；重放成功的退回操作不会再次退回。
(0, node_test_1.test)('退回重审：旧待办全部失效，新一轮重新计票，退回操作可安全重放', () => {
    const svc = newService();
    svc.publishDefinition('def', [
        { key: 'n1', approvers: ['a', 'b'], mode: 'any' },
        { key: 'n2', approvers: ['c'], mode: 'all' },
    ]);
    const app = svc.submitApplication('def');
    // 第一轮 n1：a 加签 x，然后 a 同意（any 模式即通过），b 和 x 的待办失效
    const ta = pending(app, 'n1').find((t) => t.assignee === 'a');
    svc.addsign('op-sign-1', ta.id, 'a', 'x');
    const r1 = svc.approve('op-a1', ta.id, 'a');
    assert.deepEqual(r1, { ok: true, type: 'approved' });
    let cur = svc.getApplication(app.id);
    assert.equal(cur.currentNodeKey, 'n2');
    const tbOld = cur.tasks.find((t) => t.nodeKey === 'n1' && t.assignee === 'b');
    const txOld = cur.tasks.find((t) => t.nodeKey === 'n1' && t.assignee === 'x');
    assert.equal(tbOld.status, 'invalid');
    assert.equal(txOld.status, 'invalid');
    // n2 的 c 退回到 n1
    const tc = pending(cur, 'n2')[0];
    const ret = svc.returnTo('op-ret-1', tc.id, 'c', 'n1');
    assert.deepEqual(ret, { ok: true, type: 'returned' });
    cur = svc.getApplication(app.id);
    assert.equal(cur.currentNodeKey, 'n1');
    // 新一轮 n1：只有原始名单 a、b 有新待办；临时加签的 x 不再有待办
    const round2 = pending(cur, 'n1');
    assert.deepEqual(round2.map((t) => t.assignee).sort(), ['a', 'b']);
    assert.ok(round2.every((t) => t.round === 2));
    assert.equal(cur.tasks.filter((t) => t.assignee === 'x' && t.status === 'pending').length, 0);
    // 延迟到达的旧同意（b 的旧待办、x 的旧待办）不能改变新一轮状态
    const lateB = svc.approve('op-late-b', tbOld.id, 'b');
    assert.deepEqual(lateB, { ok: false, reason: 'task_invalid' });
    const lateX = svc.approve('op-late-x', txOld.id, 'x');
    assert.deepEqual(lateX, { ok: false, reason: 'task_invalid' });
    // 延迟到达的旧加签同样失效
    const lateSign = svc.addsign('op-late-sign', tbOld.id, 'b', 'y');
    assert.deepEqual(lateSign, { ok: false, reason: 'task_invalid' });
    cur = svc.getApplication(app.id);
    assert.equal(cur.currentNodeKey, 'n1');
    assert.equal(pending(cur, 'n1').length, 2);
    // 旧操作没有产生任何新决定
    assert.equal(cur.decisions.filter((d) => d.round === 2).length, 0);
    // 重放已经成功的退回操作：返回首次结果，不再退回一次
    const before = svc.getApplication(app.id);
    const replay = svc.returnTo('op-ret-1', tc.id, 'c', 'n1');
    assert.deepEqual(replay, ret);
    const afterReplay = svc.getApplication(app.id);
    assert.equal(afterReplay.tasks.length, before.tasks.length);
    assert.equal(afterReplay.decisions.length, before.decisions.length);
    assert.ok(pending(afterReplay, 'n1').every((t) => t.round === 2));
    // 同一个人再次收到待办，必须重新同意：a 第一轮的同意不计入新一轮
    assert.equal(cur.currentNodeKey, 'n1');
    const ta2 = pending(afterReplay, 'n1').find((t) => t.assignee === 'a');
    svc.approve('op-a2', ta2.id, 'a');
    cur = svc.getApplication(app.id);
    assert.equal(cur.currentNodeKey, 'n2');
    // 用相同标识重试 a 的第二次同意，返回首次结果且不重复计票
    const retry = svc.approve('op-a2', ta2.id, 'a');
    assert.deepEqual(retry, { ok: true, type: 'approved' });
    assert.equal(svc.getApplication(app.id).decisions.filter((d) => d.action === 'approve').length, 2);
});
// 退回可以指向当前节点：当前节点本轮作废，按原始名单重来
(0, node_test_1.test)('退回到当前节点：本轮加签与待办作废，从原始名单重新开始', () => {
    const svc = newService();
    svc.publishDefinition('def', [
        { key: 'n1', approvers: ['a'], mode: 'all' },
        { key: 'n2', approvers: ['b'], mode: 'all' },
    ]);
    const app = svc.submitApplication('def');
    svc.approve('op-a', pending(app, 'n1')[0].id, 'a');
    let cur = svc.getApplication(app.id);
    const tb = pending(cur, 'n2')[0];
    svc.addsign('op-sign', tb.id, 'b', 'x');
    assert.equal(pending(svc.getApplication(app.id), 'n2').length, 2);
    const ret = svc.returnTo('op-ret', tb.id, 'b', 'n2');
    assert.deepEqual(ret, { ok: true, type: 'returned' });
    cur = svc.getApplication(app.id);
    assert.equal(cur.currentNodeKey, 'n2');
    const round2 = pending(cur, 'n2');
    assert.deepEqual(round2.map((t) => t.assignee), ['b']);
    // n1 的通过结论保留，退回后不需要重审 n1
    assert.equal(cur.currentNodeKey, 'n2');
    svc.approve('op-b2', round2[0].id, 'b');
    assert.equal(svc.getApplication(app.id).status, 'completed');
});
// 申请完成后不再接受任何审批动作
(0, node_test_1.test)('申请完成后旧待办与新操作全部失效', () => {
    const svc = newService();
    svc.publishDefinition('def', [{ key: 'n1', approvers: ['a', 'b'], mode: 'any' }]);
    const app = svc.submitApplication('def');
    const [ta] = pending(app, 'n1').filter((t) => t.assignee === 'a');
    svc.approve('op-a', ta.id, 'a');
    const done = svc.getApplication(app.id);
    assert.equal(done.status, 'completed');
    const tbOld = done.tasks.find((t) => t.assignee === 'b');
    assert.equal(tbOld.status, 'invalid');
    assert.deepEqual(svc.approve('op-late', tbOld.id, 'b'), {
        ok: false,
        reason: 'task_invalid',
    });
    assert.deepEqual(svc.addsign('op-late-2', tbOld.id, 'b', 'x'), {
        ok: false,
        reason: 'task_invalid',
    });
    assert.deepEqual(svc.returnTo('op-late-3', tbOld.id, 'b', 'n1'), {
        ok: false,
        reason: 'task_invalid',
    });
    assert.equal(svc.getApplication(app.id).status, 'completed');
});

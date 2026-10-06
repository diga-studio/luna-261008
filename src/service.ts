import { Store } from './store';
import {
  ActionResult,
  Application,
  ApplicationView,
  Definition,
  NodeSpec,
  Task,
} from './types';

export class ApprovalService {
  constructor(private readonly store: Store) {}

  /** 发布新版本的审批定义，返回发布后的定义 */
  publishDefinition(id: string, nodes: NodeSpec[]): Definition {
    if (!id) throw new Error('definition id is required');
    if (!nodes.length) throw new Error('definition must have at least one node');
    const keys = new Set<string>();
    for (const node of nodes) {
      if (!node.key) throw new Error('node key is required');
      if (keys.has(node.key)) throw new Error(`duplicate node key: ${node.key}`);
      keys.add(node.key);
      if (!node.approvers.length) {
        throw new Error(`node ${node.key} must have at least one approver`);
      }
      if (node.mode !== 'all' && node.mode !== 'any') {
        throw new Error(`node ${node.key} has invalid mode: ${node.mode}`);
      }
    }
    const prev = this.store.state.definitions.filter((d) => d.id === id);
    const version = prev.length ? Math.max(...prev.map((d) => d.version)) + 1 : 1;
    const definition: Definition = {
      id,
      version,
      nodes: nodes.map((n) => ({ key: n.key, approvers: [...n.approvers], mode: n.mode })),
    };
    this.store.state.definitions.push(definition);
    this.store.save();
    return definition;
  }

  /** 用发起时最新发布的版本发起申请 */
  submitApplication(definitionId: string): ApplicationView {
    const candidates = this.store.state.definitions.filter((d) => d.id === definitionId);
    if (!candidates.length) throw new Error(`definition not found: ${definitionId}`);
    const latest = candidates.reduce((a, b) => (a.version >= b.version ? a : b));
    const app: Application = {
      id: this.nextId('app'),
      definitionId: latest.id,
      version: latest.version,
      nodes: latest.nodes.map((n) => ({ key: n.key, approvers: [...n.approvers], mode: n.mode })),
      status: 'running',
      currentNodeIndex: 0,
      rounds: latest.nodes.map(() => 1),
      passed: latest.nodes.map(() => false),
      addsigns: latest.nodes.map(() => []),
      tasks: [],
      decisions: [],
    };
    this.store.state.applications.push(app);
    this.enterNode(app, 0);
    this.store.save();
    return this.toView(app);
  }

  approve(operationId: string, taskId: string, userId: string): ActionResult {
    return this.runOp(operationId, () => {
      const found = this.findValidTask(taskId, userId);
      if ('error' in found) return found.error;
      const { app, task } = found;
      task.status = 'approved';
      this.record(app, task, userId, 'approve', '');
      if (this.isNodePassed(app, app.currentNodeIndex)) {
        this.passNode(app);
      }
      this.store.save();
      return { ok: true, type: 'approved' };
    });
  }

  addsign(
    operationId: string,
    taskId: string,
    userId: string,
    targetUserId: string,
  ): ActionResult {
    return this.runOp(operationId, () => {
      const found = this.findValidTask(taskId, userId);
      if ('error' in found) return found.error;
      const { app, task } = found;
      const nodeIndex = app.currentNodeIndex;
      const current = this.currentApprovers(app, nodeIndex);
      if (!current.includes(targetUserId)) {
        app.addsigns[nodeIndex].push(targetUserId);
        app.tasks.push(this.newTask(app, nodeIndex, targetUserId, true));
      }
      this.record(app, task, userId, 'addsign', targetUserId);
      this.store.save();
      return { ok: true, type: 'signed' };
    });
  }

  returnTo(
    operationId: string,
    taskId: string,
    userId: string,
    targetNodeKey: string,
  ): ActionResult {
    return this.runOp(operationId, () => {
      const found = this.findValidTask(taskId, userId);
      if ('error' in found) return found.error;
      const { app, task } = found;
      const targetIndex = app.nodes.findIndex((n) => n.key === targetNodeKey);
      if (targetIndex < 0 || targetIndex > app.currentNodeIndex) {
        return { ok: false, reason: `invalid return target: ${targetNodeKey}` };
      }
      this.record(app, task, userId, 'return', targetNodeKey);
      // 目标及后续节点：旧待办、通过结论、临时加签全部失效，轮次推进
      for (let i = targetIndex; i < app.nodes.length; i++) {
        app.passed[i] = false;
        app.addsigns[i] = [];
        app.rounds[i] += 1;
        for (const t of app.tasks) {
          if (t.nodeKey === app.nodes[i].key && t.status === 'pending') {
            t.status = 'invalid';
          }
        }
      }
      app.currentNodeIndex = targetIndex;
      // 目标节点按原始名单重新产生待办
      this.enterNode(app, targetIndex);
      this.store.save();
      return { ok: true, type: 'returned' };
    });
  }

  getApplication(applicationId: string): ApplicationView {
    const app = this.store.state.applications.find((a) => a.id === applicationId);
    if (!app) throw new Error(`application not found: ${applicationId}`);
    return this.toView(app);
  }

  // ---- 内部实现 ----

  private nextId(prefix: string): string {
    this.store.state.seq += 1;
    return `${prefix}-${this.store.state.seq}`;
  }

  /** 幂等入口：相同操作标识直接返回首次结果 */
  private runOp(operationId: string, fn: () => ActionResult): ActionResult {
    if (!operationId) throw new Error('operationId is required');
    const logged = this.store.state.opLog[operationId];
    if (logged !== undefined) return logged as ActionResult;
    const result = fn();
    this.store.state.opLog[operationId] = result;
    this.store.save();
    return result;
  }

  /** 找到属于该用户的当前有效待办；旧待办/他人待办/已完成申请一律失效 */
  private findValidTask(
    taskId: string,
    userId: string,
  ): { app: Application; task: Task } | { error: ActionResult } {
    for (const app of this.store.state.applications) {
      const task = app.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      if (task.assignee !== userId) {
        return { error: { ok: false, reason: 'task does not belong to user' } };
      }
      const nodeIndex = app.nodes.findIndex((n) => n.key === task.nodeKey);
      const valid =
        app.status === 'running' &&
        task.status === 'pending' &&
        nodeIndex === app.currentNodeIndex &&
        task.round === app.rounds[nodeIndex];
      if (!valid) return { error: { ok: false, reason: 'task_invalid' } };
      return { app, task };
    }
    return { error: { ok: false, reason: 'task not found' } };
  }

  /** 节点本轮审批人名单 = 原始名单 + 本轮加签 */
  private currentApprovers(app: Application, nodeIndex: number): string[] {
    return [...app.nodes[nodeIndex].approvers, ...app.addsigns[nodeIndex]];
  }

  private isNodePassed(app: Application, nodeIndex: number): boolean {
    const node = app.nodes[nodeIndex];
    const round = app.rounds[nodeIndex];
    const approvedBy = new Set(
      app.decisions
        .filter(
          (d) =>
            d.nodeKey === node.key && d.round === round && d.action === 'approve',
        )
        .map((d) => d.actor),
    );
    if (node.mode === 'any') return approvedBy.size > 0;
    return this.currentApprovers(app, nodeIndex).every((a) => approvedBy.has(a));
  }

  /** 节点通过：其余待办失效，进入下一节点或完成申请 */
  private passNode(app: Application): void {
    const nodeIndex = app.currentNodeIndex;
    app.passed[nodeIndex] = true;
    const nodeKey = app.nodes[nodeIndex].key;
    const round = app.rounds[nodeIndex];
    for (const t of app.tasks) {
      if (t.nodeKey === nodeKey && t.round === round && t.status === 'pending') {
        t.status = 'invalid';
      }
    }
    if (nodeIndex === app.nodes.length - 1) {
      app.status = 'completed';
      return;
    }
    app.currentNodeIndex = nodeIndex + 1;
    this.enterNode(app, nodeIndex + 1);
  }

  /** 进入节点：按原始名单产生本轮待办 */
  private enterNode(app: Application, nodeIndex: number): void {
    for (const assignee of app.nodes[nodeIndex].approvers) {
      app.tasks.push(this.newTask(app, nodeIndex, assignee, false));
    }
  }

  private newTask(
    app: Application,
    nodeIndex: number,
    assignee: string,
    addedBySign: boolean,
  ): Task {
    return {
      id: this.nextId('task'),
      applicationId: app.id,
      nodeKey: app.nodes[nodeIndex].key,
      round: app.rounds[nodeIndex],
      assignee,
      addedBySign,
      status: 'pending',
    };
  }

  private record(
    app: Application,
    task: Task,
    actor: string,
    action: 'approve' | 'addsign' | 'return',
    detail: string,
  ): void {
    app.decisions.push({
      applicationId: app.id,
      nodeKey: task.nodeKey,
      round: task.round,
      actor,
      action,
      detail,
      at: Date.now(),
    });
  }

  private toView(app: Application): ApplicationView {
    return {
      id: app.id,
      definitionId: app.definitionId,
      version: app.version,
      status: app.status,
      currentNodeKey:
        app.status === 'running' ? app.nodes[app.currentNodeIndex].key : null,
      tasks: app.tasks.map((t) => ({ ...t })),
      decisions: app.decisions.map((d) => ({ ...d })),
    };
  }
}

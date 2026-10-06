import {
  ActionResult,
  ApplicationView,
  DefinitionInput,
  PublishedDefinition,
  Todo,
} from './types';
import {
  ApplicationState,
  DecisionRecord,
  FileStore,
  NodeRoundState,
  PersistedData,
  TodoRecord,
} from './store';

function ok(): ActionResult {
  return { code: 'OK', replayed: false };
}

function fail(code: ActionResult['code']): ActionResult {
  return { code, replayed: false };
}

/** 退款审批引擎：全部状态保存在内存并即时持久化到本地文件 */
export class ApprovalEngine {
  private readonly store: FileStore;
  private data: PersistedData;

  constructor(filePath: string) {
    this.store = new FileStore(filePath);
    this.data = this.store.load();
  }

  private nextId(prefix: string): string {
    this.data.seq += 1;
    return `${prefix}-${this.data.seq}`;
  }

  private persist(): void {
    this.store.save(this.data);
  }

  /** 发布审批定义，同一 id 每次发布版本号递增，返回新版本 */
  publishDefinition(input: DefinitionInput): PublishedDefinition {
    if (!input.id) throw new Error('definition id is required');
    if (!input.nodes.length) throw new Error('definition must have at least one node');
    const keys = new Set<string>();
    const nodes = input.nodes.map((n) => {
      if (keys.has(n.key)) throw new Error(`duplicate node key: ${n.key}`);
      keys.add(n.key);
      const approvers = [...new Set(n.approvers)];
      if (!approvers.length) throw new Error(`node ${n.key} must have approvers`);
      return { key: n.key, approvers, mode: n.mode };
    });
    const version =
      this.data.definitions.filter((d) => d.id === input.id).length + 1;
    const def: PublishedDefinition = { id: input.id, version, nodes };
    this.data.definitions.push(def);
    this.persist();
    return def;
  }

  private latestDefinition(id: string): PublishedDefinition {
    const defs = this.data.definitions.filter((d) => d.id === id);
    if (!defs.length) throw new Error(`definition not found: ${id}`);
    return defs[defs.length - 1];
  }

  /** 发起申请，冻结发起时最新发布的版本 */
  createApplication(definitionId: string): string {
    const def = this.latestDefinition(definitionId);
    const app: ApplicationState = {
      id: this.nextId('app'),
      definitionId: def.id,
      definitionVersion: def.version,
      definition: JSON.parse(JSON.stringify(def)) as PublishedDefinition,
      status: 'RUNNING',
      currentNodeIndex: 0,
      rounds: [],
      todos: [],
      decisions: [],
    };
    this.data.applications.push(app);
    this.enterNode(app, 0);
    this.persist();
    return app.id;
  }

  /** 进入节点：按申请绑定版本的原始名单开启新一轮并产生待办 */
  private enterNode(app: ApplicationState, nodeIndex: number): void {
    const node = app.definition.nodes[nodeIndex];
    const round =
      app.rounds.filter((r) => r.nodeIndex === nodeIndex).length + 1;
    const state: NodeRoundState = {
      nodeIndex,
      round,
      approvers: [...node.approvers],
      approvedBy: [],
      passed: false,
      voided: false,
    };
    app.rounds.push(state);
    app.currentNodeIndex = nodeIndex;
    for (const assignee of node.approvers) {
      app.todos.push({
        id: this.nextId('todo'),
        applicationId: app.id,
        nodeIndex,
        round,
        assignee,
        status: 'PENDING',
        addedBySign: false,
      });
    }
  }

  private findAppOfTodo(todoId: string): { app: ApplicationState; todo: TodoRecord } | null {
    for (const app of this.data.applications) {
      const todo = app.todos.find((t) => t.id === todoId);
      if (todo) return { app, todo };
    }
    return null;
  }

  private roundOf(app: ApplicationState, todo: TodoRecord): NodeRoundState {
    const round = app.rounds.find(
      (r) => r.nodeIndex === todo.nodeIndex && r.round === todo.round,
    );
    if (!round) throw new Error('round state missing');
    return round;
  }

  /** 操作入口公共校验与幂等处理 */
  private execute(
    opId: string,
    todoId: string,
    userId: string,
    run: (app: ApplicationState, todo: TodoRecord) => ActionResult,
  ): ActionResult {
    const replayed = this.data.ops[opId];
    if (replayed) {
      return { ...replayed, replayed: true };
    }
    let result: ActionResult;
    const found = this.findAppOfTodo(todoId);
    if (!found || found.todo.status !== 'PENDING') {
      result = fail('TODO_INVALID');
    } else if (found.todo.assignee !== userId) {
      result = fail('NOT_ASSIGNEE');
    } else if (found.app.status !== 'RUNNING') {
      result = fail('APP_CLOSED');
    } else {
      result = run(found.app, found.todo);
    }
    this.data.ops[opId] = result;
    this.persist();
    return result;
  }

  /** 同意 */
  approve(todoId: string, userId: string, opId: string): ActionResult {
    return this.execute(opId, todoId, userId, (app, todo) => {
      const round = this.roundOf(app, todo);
      todo.status = 'APPROVED';
      if (!round.approvedBy.includes(userId)) {
        round.approvedBy.push(userId);
      }
      app.decisions.push(this.decision(app, todo, userId, 'APPROVE', '', opId));
      this.maybePass(app, round);
      return ok();
    });
  }

  /** 加签：把指定用户加入当前节点本轮审批人名单 */
  addSign(todoId: string, userId: string, opId: string, addUserId: string): ActionResult {
    return this.execute(opId, todoId, userId, (app, todo) => {
      const round = this.roundOf(app, todo);
      if (!round.approvers.includes(addUserId)) {
        round.approvers.push(addUserId);
        app.todos.push({
          id: this.nextId('todo'),
          applicationId: app.id,
          nodeIndex: todo.nodeIndex,
          round: todo.round,
          assignee: addUserId,
          status: 'PENDING',
          addedBySign: true,
        });
      }
      app.decisions.push(this.decision(app, todo, userId, 'ADD_SIGN', addUserId, opId));
      return ok();
    });
  }

  /** 退回到当前节点或任一之前节点 */
  sendBack(todoId: string, userId: string, opId: string, targetNodeIndex: number): ActionResult {
    return this.execute(opId, todoId, userId, (app, todo) => {
      if (
        !Number.isInteger(targetNodeIndex) ||
        targetNodeIndex < 0 ||
        targetNodeIndex > todo.nodeIndex
      ) {
        return fail('INVALID_TARGET');
      }
      app.decisions.push(
        this.decision(app, todo, userId, 'SEND_BACK', String(targetNodeIndex), opId),
      );
      // 目标节点及后续节点的旧轮次（含通过结论、临时加签）全部作废
      for (const round of app.rounds) {
        if (round.nodeIndex >= targetNodeIndex) {
          round.voided = true;
          round.passed = false;
        }
      }
      for (const t of app.todos) {
        if (t.status === 'PENDING' && t.nodeIndex >= targetNodeIndex) {
          t.status = 'INVALIDATED';
        }
      }
      // 目标节点按原始名单重新产生待办
      this.enterNode(app, targetNodeIndex);
      return ok();
    });
  }

  private decision(
    app: ApplicationState,
    todo: TodoRecord,
    userId: string,
    action: DecisionRecord['action'],
    detail: string,
    opId: string,
  ): DecisionRecord {
    return {
      applicationId: app.id,
      nodeIndex: todo.nodeIndex,
      round: todo.round,
      userId,
      action,
      detail,
      opId,
      seq: ++this.data.seq,
    };
  }

  /** 检查本轮通过条件，通过后推进流程 */
  private maybePass(app: ApplicationState, round: NodeRoundState): void {
    const node = app.definition.nodes[round.nodeIndex];
    const passed =
      node.mode === 'ANY'
        ? round.approvedBy.length > 0
        : round.approvers.every((a) => round.approvedBy.includes(a));
    if (!passed) return;
    round.passed = true;
    // 节点通过，其余未处理待办立即失效
    for (const t of app.todos) {
      if (
        t.status === 'PENDING' &&
        t.nodeIndex === round.nodeIndex &&
        t.round === round.round
      ) {
        t.status = 'INVALIDATED';
      }
    }
    if (round.nodeIndex === app.definition.nodes.length - 1) {
      app.status = 'COMPLETED';
    } else {
      this.enterNode(app, round.nodeIndex + 1);
    }
  }

  private toView(app: ApplicationState, todo: TodoRecord): Todo {
    return {
      id: todo.id,
      applicationId: todo.applicationId,
      nodeKey: app.definition.nodes[todo.nodeIndex].key,
      nodeIndex: todo.nodeIndex,
      round: todo.round,
      assignee: todo.assignee,
      status: todo.status,
      addedBySign: todo.addedBySign,
    };
  }

  /** 查询申请状态（含全部待办，可区分有效/失效） */
  getApplication(applicationId: string): ApplicationView {
    const app = this.data.applications.find((a) => a.id === applicationId);
    if (!app) throw new Error(`application not found: ${applicationId}`);
    const current =
      app.status === 'RUNNING' ? app.definition.nodes[app.currentNodeIndex] : null;
    return {
      id: app.id,
      definitionId: app.definitionId,
      definitionVersion: app.definitionVersion,
      status: app.status,
      currentNodeIndex: app.status === 'RUNNING' ? app.currentNodeIndex : null,
      currentNodeKey: current ? current.key : null,
      todos: app.todos.map((t) => this.toView(app, t)),
    };
  }

  /** 查询某用户当前有效待办 */
  listPendingTodos(userId: string): Todo[] {
    const result: Todo[] = [];
    for (const app of this.data.applications) {
      for (const t of app.todos) {
        if (t.status === 'PENDING' && t.assignee === userId) {
          result.push(this.toView(app, t));
        }
      }
    }
    return result;
  }

  /** 查询申请的历史决定（含已作废轮次，仅供查询） */
  listDecisions(applicationId: string): DecisionRecord[] {
    const app = this.data.applications.find((a) => a.id === applicationId);
    if (!app) throw new Error(`application not found: ${applicationId}`);
    return [...app.decisions];
  }
}

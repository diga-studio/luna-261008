import {
  DecisionNode,
  InstanceState,
  InstanceStatus,
  NodeDefinition,
  NodeRunState,
  WorkflowDefinition,
} from './types';

interface NodeRuntime {
  def: NodeDefinition;
  state: NodeRunState;
  /** 入边来源节点 id（按定义顺序） */
  incoming: string[];
  /** 已实际到达的入边来源 */
  arrivedFrom: Set<string>;
  /** 人工任务提交的结果 */
  taskResult?: boolean;
}

interface Instance {
  id: string;
  definitionId: string;
  state: InstanceState;
  nodes: Map<string, NodeRuntime>;
  /** 定义中的节点顺序，用于状态输出的稳定排序 */
  order: string[];
}

interface CompiledDefinition {
  def: WorkflowDefinition;
  nodes: Map<string, NodeDefinition>;
  incoming: Map<string, string[]>;
}

function outgoingOf(node: NodeDefinition): string[] {
  if (node.kind === 'decision') {
    return node.onTrue === node.onFalse ? [node.onTrue] : [node.onTrue, node.onFalse];
  }
  return node.outgoing;
}

export class WorkflowEngine {
  private readonly definitions = new Map<string, CompiledDefinition>();
  private readonly instances = new Map<string, Instance>();
  private nextInstanceId = 1;

  /** 注册工作流定义（校验 DAG、单入口、汇合多入口等约束） */
  registerDefinition(definition: WorkflowDefinition): void {
    const compiled = this.compile(definition);
    this.definitions.set(definition.id, compiled);
  }

  /** 启动一个实例，返回实例 id */
  startInstance(definitionId: string): string {
    const compiled = this.definitions.get(definitionId);
    if (!compiled) {
      throw new Error(`unknown workflow definition: ${definitionId}`);
    }
    const nodes = new Map<string, NodeRuntime>();
    for (const [id, def] of compiled.nodes) {
      nodes.set(id, {
        def,
        state: 'pending',
        incoming: compiled.incoming.get(id) ?? [],
        arrivedFrom: new Set<string>(),
      });
    }
    const instanceId = `inst-${this.nextInstanceId++}`;
    const instance: Instance = {
      id: instanceId,
      definitionId,
      state: 'running',
      nodes,
      order: [...compiled.nodes.keys()],
    };
    this.instances.set(instanceId, instance);
    this.activate(instance, instance.nodes.get(compiled.def.entry)!);
    this.settle(instance);
    return instanceId;
  }

  /** 提交当前待办人工任务的布尔结果，返回结算后的实例状态 */
  submitTaskResult(instanceId: string, taskId: string, result: boolean): InstanceStatus {
    const instance = this.requireRunningInstance(instanceId);
    const node = instance.nodes.get(taskId);
    if (!node || node.def.kind !== 'task') {
      throw new Error(`node ${taskId} is not a task in instance ${instanceId}`);
    }
    if (node.state !== 'active') {
      throw new Error(`task ${taskId} is not currently todo in instance ${instanceId}`);
    }
    node.taskResult = result;
    this.complete(instance, node);
    this.settle(instance);
    return this.getInstanceStatus(instanceId);
  }

  /** 查看实例状态 */
  getInstanceStatus(instanceId: string): InstanceStatus {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`unknown instance: ${instanceId}`);
    }
    const todoTasks: string[] = [];
    const completedNodes: string[] = [];
    const excludedNodes: string[] = [];
    const pendingNodes: string[] = [];
    for (const id of instance.order) {
      const node = instance.nodes.get(id)!;
      switch (node.state) {
        case 'active':
          if (node.def.kind === 'task') todoTasks.push(id);
          break;
        case 'completed':
          completedNodes.push(id);
          break;
        case 'excluded':
          excludedNodes.push(id);
          break;
        case 'pending':
          pendingNodes.push(id);
          break;
      }
    }
    return {
      instanceId: instance.id,
      definitionId: instance.definitionId,
      state: instance.state,
      todoTasks,
      completedNodes,
      excludedNodes,
      pendingNodes,
    };
  }

  // ---- 定义校验 ----

  private compile(definition: WorkflowDefinition): CompiledDefinition {
    if (this.definitions.has(definition.id)) {
      throw new Error(`duplicate workflow definition: ${definition.id}`);
    }
    if (definition.nodes.length === 0) {
      throw new Error(`definition ${definition.id} has no nodes`);
    }
    const nodes = new Map<string, NodeDefinition>();
    for (const node of definition.nodes) {
      if (nodes.has(node.id)) {
        throw new Error(`duplicate node id: ${node.id}`);
      }
      nodes.set(node.id, node);
    }
    const entry = nodes.get(definition.entry);
    if (!entry) {
      throw new Error(`entry node not found: ${definition.entry}`);
    }

    const incoming = new Map<string, string[]>();
    for (const id of nodes.keys()) incoming.set(id, []);
    for (const node of definition.nodes) {
      for (const target of outgoingOf(node)) {
        if (!nodes.has(target)) {
          throw new Error(`node ${node.id} references unknown target: ${target}`);
        }
        incoming.get(target)!.push(node.id);
      }
    }

    this.assertAcyclic(definition);

    for (const node of definition.nodes) {
      const sources = incoming.get(node.id)!;
      if (node.kind !== 'join' && sources.length > 1) {
        throw new Error(`node ${node.id} has multiple incoming edges; only joins may`);
      }
      if (node.kind === 'decision') {
        if (sources.length !== 1) {
          throw new Error(`decision ${node.id} must have exactly one incoming task`);
        }
        const source = nodes.get(sources[0]!)!;
        if (source.kind !== 'task') {
          throw new Error(`decision ${node.id} must directly follow a task, got ${source.kind}`);
        }
      }
    }
    if (incoming.get(entry.id)!.length > 0) {
      throw new Error(`entry node ${entry.id} must not have incoming edges`);
    }

    return { def: definition, nodes, incoming };
  }

  private assertAcyclic(definition: WorkflowDefinition): void {
    const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`workflow definition ${definition.id} contains a cycle at node ${id}`);
      }
      visiting.add(id);
      for (const next of outgoingOf(nodes.get(id)!)) visit(next);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of nodes.keys()) visit(id);
  }

  // ---- 运行时推进 ----

  private requireRunningInstance(instanceId: string): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`unknown instance: ${instanceId}`);
    }
    if (instance.state !== 'running') {
      throw new Error(`instance ${instanceId} is already completed`);
    }
    return instance;
  }

  /** 激活节点：每个节点在一个实例中最多激活一次 */
  private activate(instance: Instance, node: NodeRuntime): void {
    if (node.state !== 'pending') return;
    node.state = 'active';
    if (node.def.kind === 'fork') {
      this.complete(instance, node);
    } else if (node.def.kind === 'decision') {
      const sourceId = node.incoming[0]!;
      const source = instance.nodes.get(sourceId)!;
      const result = source.taskResult;
      if (result === undefined) {
        throw new Error(`decision ${node.def.id} activated before its task ${sourceId} submitted`);
      }
      const decision = node.def as DecisionNode;
      const chosen = result ? decision.onTrue : decision.onFalse;
      node.state = 'completed';
      this.fireEdge(instance, node, chosen);
    }
  }

  /** 节点执行完成，沿出边推进 */
  private complete(instance: Instance, node: NodeRuntime): void {
    node.state = 'completed';
    if (node.def.kind === 'decision') return; // 决策在 activate 中已按选路推进
    for (const target of node.def.outgoing) {
      this.fireEdge(instance, node, target);
    }
  }

  private fireEdge(instance: Instance, from: NodeRuntime, targetId: string): void {
    const target = instance.nodes.get(targetId)!;
    target.arrivedFrom.add(from.def.id);
    if (target.def.kind === 'join') {
      if (target.state === 'pending') target.state = 'active';
    } else {
      this.activate(instance, target);
    }
  }

  /** 入边是否仍可能到达：来源尚未确定（pending/active） */
  private isEdgeLive(instance: Instance, sourceId: string): boolean {
    const source = instance.nodes.get(sourceId)!;
    return source.state === 'pending' || source.state === 'active';
  }

  /**
   * 结算循环：重复执行排除传播与汇合放行，直到不再需要人工结果就能确定的推进全部生效。
   */
  private settle(instance: Instance): void {
    let progressed = true;
    while (progressed) {
      progressed = false;

      // 排除传播：所有入边都确定不会到达的 pending 节点被排除
      let excludedAny = true;
      while (excludedAny) {
        excludedAny = false;
        for (const node of instance.nodes.values()) {
          if (node.state !== 'pending') continue;
          const hasLiveEdge = node.incoming.some((sourceId) => this.isEdgeLive(instance, sourceId));
          if (!hasLiveEdge) {
            node.state = 'excluded';
            excludedAny = true;
            progressed = true;
          }
        }
      }

      // 汇合放行：全部入边已到达或已排除时放行；全部入口被排除则汇合自身被排除
      for (const node of instance.nodes.values()) {
        if (node.state !== 'active' || node.def.kind !== 'join') continue;
        const allResolved = node.incoming.every(
          (sourceId) => node.arrivedFrom.has(sourceId) || !this.isEdgeLive(instance, sourceId),
        );
        if (!allResolved) continue;
        if (node.arrivedFrom.size > 0) {
          this.complete(instance, node);
        } else {
          node.state = 'excluded';
        }
        progressed = true;
      }
    }

    if (![...instance.nodes.values()].some((n) => n.state === 'active')) {
      instance.state = 'completed';
    }
  }
}

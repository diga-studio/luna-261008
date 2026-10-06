import { randomUUID } from 'node:crypto';
import { validateDefinition, DefinitionError } from './definition.ts';
import type {
  InstanceStatus,
  NodeStatus,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from './types.ts';

export class WorkflowError extends Error {}

/** open: 尚未确定；fired: 本次会有令牌到达；dead: 已确定本次不会到达 */
type EdgeState = 'open' | 'fired' | 'dead';

/** waiting: 尚未确定；active: 人工任务待办；done: 已执行/已放行；skipped: 确定不执行 */
type NodeState = 'waiting' | 'active' | 'done' | 'skipped';

interface CompiledDefinition {
  def: WorkflowDefinition;
  nodes: Map<string, WorkflowNode>;
  outEdges: Map<string, WorkflowEdge[]>;
  inEdges: Map<string, WorkflowEdge[]>;
}

interface Instance {
  id: string;
  compiled: CompiledDefinition;
  nodeState: Map<string, NodeState>;
  edgeState: Map<string, EdgeState>;
}

const edgeKey = (edge: WorkflowEdge): string => `${edge.from}->${edge.to}`;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 进程内工作流引擎：定义与实例状态均保存在内存中。 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, CompiledDefinition>();
  private readonly instances = new Map<string, Instance>();

  defineWorkflow(def: WorkflowDefinition): void {
    validateDefinition(def);
    if (this.definitions.has(def.id)) {
      throw new DefinitionError(`workflow already defined: ${def.id}`);
    }
    const frozen = deepFreeze(structuredClone(def));
    const nodes = new Map(frozen.nodes.map((n) => [n.id, n]));
    const outEdges = new Map<string, WorkflowEdge[]>();
    const inEdges = new Map<string, WorkflowEdge[]>();
    for (const edge of frozen.edges) {
      outEdges.set(edge.from, [...(outEdges.get(edge.from) ?? []), edge]);
      inEdges.set(edge.to, [...(inEdges.get(edge.to) ?? []), edge]);
    }
    this.definitions.set(frozen.id, { def: frozen, nodes, outEdges, inEdges });
  }

  startInstance(definitionId: string): string {
    const compiled = this.definitions.get(definitionId);
    if (!compiled) {
      throw new WorkflowError(`unknown workflow definition: ${definitionId}`);
    }
    const instance: Instance = {
      id: randomUUID(),
      compiled,
      nodeState: new Map(compiled.def.nodes.map((n) => [n.id, 'waiting' as NodeState])),
      edgeState: new Map(compiled.def.edges.map((e) => [edgeKey(e), 'open' as EdgeState])),
    };
    this.instances.set(instance.id, instance);
    this.activate(instance, compiled.def.entry);
    return instance.id;
  }

  submitResult(instanceId: string, taskId: string, result?: unknown): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new WorkflowError(`unknown instance: ${instanceId}`);
    }
    const node = instance.compiled.nodes.get(taskId);
    if (!node || node.kind !== 'task') {
      throw new WorkflowError(`not a task node: ${taskId}`);
    }
    const outs = instance.compiled.outEdges.get(taskId) ?? [];
    const soleTarget =
      outs.length === 1 ? instance.compiled.nodes.get(outs[0].to)! : undefined;
    if (soleTarget?.kind === 'decision' && typeof result !== 'boolean') {
      throw new WorkflowError(
        `task ${taskId} feeds decision ${soleTarget.id}: result must be boolean`,
      );
    }
    if (instance.nodeState.get(taskId) !== 'active') {
      throw new WorkflowError(`task is not pending in this instance: ${taskId}`);
    }
    instance.nodeState.set(taskId, 'done');

    if (outs.length === 1) {
      const edge = outs[0];
      if (soleTarget!.kind === 'decision') {
        this.resolveDecision(instance, soleTarget!, result as boolean);
      } else {
        this.fireEdge(instance, edge);
      }
    }
  }

  getStatus(instanceId: string): InstanceStatus {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new WorkflowError(`unknown instance: ${instanceId}`);
    }
    const view: Record<NodeState, NodeStatus> = {
      waiting: 'pending',
      active: 'todo',
      done: 'done',
      skipped: 'skipped',
    };
    const nodes = instance.compiled.def.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      status: view[instance.nodeState.get(n.id)!],
    }));
    const hasActive = nodes.some((n) => n.status === 'todo');
    return {
      instanceId: instance.id,
      definitionId: instance.compiled.def.id,
      state: hasActive ? 'running' : 'completed',
      nodes,
    };
  }

  private activate(instance: Instance, nodeId: string): void {
    if (instance.nodeState.get(nodeId) !== 'waiting') return;
    const node = instance.compiled.nodes.get(nodeId)!;
    switch (node.kind) {
      case 'task':
        instance.nodeState.set(nodeId, 'active');
        return;
      case 'fork':
        instance.nodeState.set(nodeId, 'done');
        for (const edge of instance.compiled.outEdges.get(nodeId) ?? []) {
          this.fireEdge(instance, edge);
        }
        return;
      case 'join':
        this.evaluateJoin(instance, nodeId);
        return;
      case 'decision':
        throw new WorkflowError(`decision cannot be activated directly: ${nodeId}`);
    }
  }

  private resolveDecision(instance: Instance, decision: WorkflowNode, result: boolean): void {
    if (instance.nodeState.get(decision.id) !== 'waiting') return;
    instance.nodeState.set(decision.id, 'done');
    for (const edge of instance.compiled.outEdges.get(decision.id) ?? []) {
      if (edge.condition === result) {
        this.fireEdge(instance, edge);
      } else {
        this.killEdge(instance, edge);
      }
    }
  }

  private fireEdge(instance: Instance, edge: WorkflowEdge): void {
    if (instance.edgeState.get(edgeKey(edge)) !== 'open') return;
    instance.edgeState.set(edgeKey(edge), 'fired');
    const target = instance.compiled.nodes.get(edge.to)!;
    if (target.kind === 'join') {
      this.evaluateJoin(instance, target.id);
    } else {
      this.activate(instance, target.id);
    }
  }

  private killEdge(instance: Instance, edge: WorkflowEdge): void {
    if (instance.edgeState.get(edgeKey(edge)) !== 'open') return;
    instance.edgeState.set(edgeKey(edge), 'dead');
    const target = instance.compiled.nodes.get(edge.to)!;
    if (target.kind === 'join') {
      this.evaluateJoin(instance, target.id);
    } else {
      this.skipNode(instance, target.id);
    }
  }

  private skipNode(instance: Instance, nodeId: string): void {
    if (instance.nodeState.get(nodeId) !== 'waiting') return;
    instance.nodeState.set(nodeId, 'skipped');
    for (const edge of instance.compiled.outEdges.get(nodeId) ?? []) {
      this.killEdge(instance, edge);
    }
  }

  /**
   * 汇合放行条件：全部入口均已确定（fired 或 dead）且至少一个实际到达。
   * 全部入口被排除时汇合不执行，排除结果沿出边继续传播。
   */
  private evaluateJoin(instance: Instance, joinId: string): void {
    if (instance.nodeState.get(joinId) !== 'waiting') return;
    const ins = instance.compiled.inEdges.get(joinId) ?? [];
    let fired = 0;
    let dead = 0;
    for (const edge of ins) {
      const state = instance.edgeState.get(edgeKey(edge));
      if (state === 'fired') fired += 1;
      else if (state === 'dead') dead += 1;
      else return; // 仍有未确定的入口：继续等待
    }
    if (fired > 0) {
      instance.nodeState.set(joinId, 'done');
      for (const edge of instance.compiled.outEdges.get(joinId) ?? []) {
        this.fireEdge(instance, edge);
      }
    } else if (dead === ins.length) {
      this.skipNode(instance, joinId);
    }
  }
}

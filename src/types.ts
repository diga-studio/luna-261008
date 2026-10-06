/** 节点种类：人工任务 / 二选一决策网关 / 并行分叉 / 并行汇合 */
export type NodeKind = 'task' | 'decision' | 'fork' | 'join';

export interface BaseNode {
  id: string;
  kind: NodeKind;
}

export interface TaskNode extends BaseNode {
  kind: 'task';
  /** 出边目标节点 id 列表 */
  outgoing: string[];
}

export interface ForkNode extends BaseNode {
  kind: 'fork';
  /** 出边目标节点 id 列表，分叉沿全部出边推进 */
  outgoing: string[];
}

export interface JoinNode extends BaseNode {
  kind: 'join';
  /** 出边目标节点 id 列表 */
  outgoing: string[];
}

export interface DecisionNode extends BaseNode {
  kind: 'decision';
  /** 紧接的前置人工任务结果为 true 时走的出边 */
  onTrue: string;
  /** 结果为 false 时走的出边 */
  onFalse: string;
}

export type NodeDefinition = TaskNode | ForkNode | JoinNode | DecisionNode;

export interface WorkflowDefinition {
  id: string;
  /** 唯一入口节点 id */
  entry: string;
  nodes: NodeDefinition[];
}

/** 节点在一个实例内的运行状态 */
export type NodeRunState =
  | 'pending' // 尚未确定（可能到达，也可能被排除）
  | 'active' // 已激活：任务待提交 / 汇合等待入口
  | 'completed' // 已执行完成
  | 'excluded'; // 已确定本次不会执行

export type InstanceState = 'running' | 'completed';

export interface InstanceStatus {
  instanceId: string;
  definitionId: string;
  state: InstanceState;
  /** 当前待办人工任务 */
  todoTasks: string[];
  /** 已执行完成的节点 */
  completedNodes: string[];
  /** 已确定本次不会执行的节点 */
  excludedNodes: string[];
  /** 尚未确定的节点 */
  pendingNodes: string[];
}

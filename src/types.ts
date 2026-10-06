export type NodeKind = 'task' | 'decision' | 'fork' | 'join';

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  name?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** 仅允许出现在决策网关的出边上：true 走真分支，false 走假分支 */
  condition?: boolean;
}

export interface WorkflowDefinition {
  id: string;
  /** 唯一入口节点 id */
  entry: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * pending: 尚未确定本次是否执行
 * todo:    待办（人工任务等待提交结果）
 * done:    已完成/已放行
 * skipped: 已确定本次不会执行
 */
export type NodeStatus = 'pending' | 'todo' | 'done' | 'skipped';

export interface NodeStateView {
  id: string;
  kind: NodeKind;
  status: NodeStatus;
}

export type InstanceState = 'running' | 'completed';

export interface InstanceStatus {
  instanceId: string;
  definitionId: string;
  state: InstanceState;
  nodes: NodeStateView[];
}

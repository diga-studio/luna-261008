export type NodeType = "process" | "condition";

export interface WorkflowNode {
  id: string;
  type: NodeType;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface Workflow {
  entry: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type JsonObject = Record<string, unknown>;

export interface HandlerResult {
  output?: JsonObject;
  confidence?: number;
  /** condition 节点专用：选中的后继节点 id 子集 */
  select?: string[];
}

export interface HandlerContext {
  runId: string;
  nodeId: string;
  attempt: number;
}

export type Handler = (
  input: JsonObject,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

export interface Handlers {
  process?: Record<string, Handler>;
  condition?: Record<string, Handler>;
}

export type NodeStatus =
  | "pending"
  | "running"
  | "waiting_retry"
  | "awaiting_review"
  | "succeeded"
  | "skipped";

export type EdgeStatus = "undetermined" | "selected" | "excluded";

export type RunStatus = "running" | "succeeded" | "failed";

export interface ReviewTaskSnapshot {
  taskId: string;
  nodeId: string;
  status: "pending" | "resolved";
  originalOutput: JsonObject;
  confidence: number;
  correctedOutput?: JsonObject;
}

export interface NodeSnapshot {
  nodeId: string;
  type: NodeType;
  status: NodeStatus;
  attempts: number;
  output?: JsonObject;
}

export interface EdgeSnapshot {
  from: string;
  to: string;
  status: EdgeStatus;
}

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  error?: string;
  nodes: NodeSnapshot[];
  edges: EdgeSnapshot[];
  reviewTasks: ReviewTaskSnapshot[];
}

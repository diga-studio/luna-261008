/** 工作流定义（JSON 传入）。运行期间不变。 */

export type NodeKind = "process" | "condition";

export interface WorkflowNodeDef {
  id: string;
  kind: NodeKind;
}

export interface WorkflowEdgeDef {
  from: string;
  to: string;
}

export interface WorkflowDef {
  /** 唯一入口节点 id，接收已提取的文档字段 */
  entry: string;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
}

/** 处理器相关类型 */

/** 节点输入：选中前驱节点 id -> 该前驱最终输出；入口节点为文档字段本身 */
export type NodeInput = Record<string, unknown>;

export interface ProcessResult {
  /** 节点输出，发布给下游 */
  output: unknown;
  /** 0-100，可选；低于 70 触发人工复核 */
  confidence?: number;
}

export interface ConditionResult {
  /** 条件节点自身输出（同样会发布给被选中的下游） */
  output?: unknown;
  /** 选中的后继节点 id 子集，可为空集 */
  select: string[];
}

export type ProcessHandler = (input: NodeInput) => Promise<ProcessResult>;
export type ConditionHandler = (input: NodeInput) => Promise<ConditionResult>;

export interface Handlers {
  process?: Record<string, ProcessHandler>;
  condition?: Record<string, ConditionHandler>;
}

/** 运行状态快照 */

export type RunStatus = "running" | "succeeded" | "failed";

export type NodeState =
  | "pending" // 入边尚未全部确定
  | "ready" // 已决定执行，等待/正在运行（含等待重试）
  | "awaiting_review" // 低置信度，等待人工复核
  | "succeeded"
  | "skipped"
  | "failed";

export type EdgeState = "undetermined" | "selected" | "excluded";

export interface NodeSnapshot {
  id: string;
  kind: NodeKind;
  state: NodeState;
  /** 已进行的尝试次数 */
  attempts: number;
  /** 成功节点的最终输出（跳过/失败无输出） */
  output?: unknown;
  /** 最近一次失败信息 */
  lastError?: string;
}

export interface EdgeSnapshot {
  from: string;
  to: string;
  state: EdgeState;
}

export type ReviewTaskStatus = "pending" | "resolved";

export interface ReviewTaskSnapshot {
  id: string;
  nodeId: string;
  status: ReviewTaskStatus;
  /** 触发复核的原始结果 */
  originalOutput: unknown;
  confidence: number;
  /** 复核提交的修正字段（整体替代原结果） */
  correction?: unknown;
}

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  /** 运行失败原因 */
  error?: string;
  nodes: NodeSnapshot[];
  edges: EdgeSnapshot[];
  reviewTasks: ReviewTaskSnapshot[];
}

/** 运行库配置 */

export interface RunnerOptions {
  /** 重试等待时长（毫秒），默认 [2000, 8000, 32000]；测试可注入小值 */
  retryDelaysMs?: number[];
  /** 可注入的 sleep，便于测试 */
  sleep?: (ms: number) => Promise<void>;
}

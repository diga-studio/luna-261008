export type AgentId = string;
export type CallId = string;
export type Key = string;

export type HandoffFn = (
  callId: CallId,
  fromAgentId: AgentId,
  toAgentId: AgentId
) => Promise<void>;

export interface CallInfo {
  callId: CallId;
  agentId: AgentId;
}

export interface Snapshot {
  /** callId -> owner agentId */
  calls: ReadonlyMap<CallId, AgentId>;
  /** agentId -> owned callId */
  agents: ReadonlyMap<AgentId, CallId>;
}

export type OpKind = "open" | "transfer" | "close";

export type FailureCode =
  | "AGENT_BUSY"
  | "AGENT_NOT_OWNER"
  | "CALL_NOT_FOUND"
  | "TARGET_BUSY"
  | "TARGET_SAME_AS_SOURCE"
  | "HANDOFF_FAILED"
  | "KEY_CONFLICT";

export interface Failure {
  ok: false;
  code: FailureCode;
  message: string;
}

export interface OpenSuccess {
  ok: true;
  callId: CallId;
}
export type OpenResult = OpenSuccess | Failure;

export interface TransferSuccess {
  ok: true;
  callId: CallId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
}
export type TransferResult = TransferSuccess | Failure;

export interface CloseSuccess {
  ok: true;
  callId: CallId;
}
export type CloseResult = CloseSuccess | Failure;

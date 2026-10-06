export type AgentId = string;
export type CallId = string;
export type OpKey = string;

export type OpenCallError = "AGENT_BUSY";
export type TransferCallError =
  | "CALL_NOT_FOUND"
  | "NOT_OWNER"
  | "TARGET_BUSY"
  | "SAME_AGENT"
  | "HANDOFF_FAILED";
export type CloseCallError = "CALL_NOT_FOUND" | "NOT_OWNER";

export type OpenCallResult =
  | { ok: true; callId: CallId }
  | { ok: false; error: OpenCallError };

export type TransferCallResult =
  | { ok: true }
  | { ok: false; error: TransferCallError };

export type CloseCallResult =
  | { ok: true }
  | { ok: false; error: CloseCallError };

export interface CallInfo {
  callId: CallId;
  agentId: AgentId;
}

export interface Snapshot {
  readonly calls: readonly CallInfo[];
  readonly agentCalls: Readonly<Record<AgentId, CallId>>;
}

export type HandoffFn = (
  callId: CallId,
  fromAgentId: AgentId,
  toAgentId: AgentId
) => Promise<void>;

export interface CallOwnership {
  openCall(agentId: AgentId, key: OpKey): Promise<OpenCallResult>;
  transferCall(
    callId: CallId,
    fromAgentId: AgentId,
    toAgentId: AgentId,
    key: OpKey
  ): Promise<TransferCallResult>;
  closeCall(callId: CallId, agentId: AgentId, key: OpKey): Promise<CloseCallResult>;
  snapshot(): Snapshot;
}

export class KeyConflictError extends Error {
  readonly key: OpKey;
  constructor(key: OpKey) {
    super(`key conflict: "${key}" is already used by a different operation`);
    this.name = "KeyConflictError";
    this.key = key;
  }
}

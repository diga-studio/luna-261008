import type {
  AgentId,
  CallId,
  CallOwnership,
  CloseCallResult,
  HandoffFn,
  OpKey,
  OpenCallResult,
  Snapshot,
  TransferCallResult,
} from "./types";
import { KeyConflictError } from "./types";

interface KeyRecord {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
}

export class CallOwnershipService implements CallOwnership {
  private readonly calls = new Map<CallId, AgentId>();
  private readonly agentCall = new Map<AgentId, CallId>();
  private readonly keyRecords = new Map<OpKey, KeyRecord>();
  private readonly resourceTails = new Map<string, Promise<void>>();
  private nextCallSeq = 1;

  constructor(private readonly handoff: HandoffFn) {}

  openCall(agentId: AgentId, key: OpKey): Promise<OpenCallResult> {
    const fingerprint = `open${agentId}`;
    const existing = this.keyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new KeyConflictError(key);
      return existing.result as Promise<OpenCallResult>;
    }
    const result = this.enqueue([`agent:${agentId}`], () =>
      Promise.resolve(this.doOpenCall(agentId))
    );
    this.keyRecords.set(key, { fingerprint, result });
    return result;
  }

  transferCall(
    callId: CallId,
    fromAgentId: AgentId,
    toAgentId: AgentId,
    key: OpKey
  ): Promise<TransferCallResult> {
    const fingerprint = `transfer${callId}${fromAgentId}${toAgentId}`;
    const existing = this.keyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new KeyConflictError(key);
      return existing.result as Promise<TransferCallResult>;
    }
    const result = this.enqueue(
      [`call:${callId}`, `agent:${fromAgentId}`, `agent:${toAgentId}`],
      () => this.doTransferCall(callId, fromAgentId, toAgentId)
    );
    this.keyRecords.set(key, { fingerprint, result });
    return result;
  }

  closeCall(callId: CallId, agentId: AgentId, key: OpKey): Promise<CloseCallResult> {
    const fingerprint = `close${callId}${agentId}`;
    const existing = this.keyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new KeyConflictError(key);
      return existing.result as Promise<CloseCallResult>;
    }
    const result = this.enqueue(
      [`call:${callId}`, `agent:${agentId}`],
      () => Promise.resolve(this.doCloseCall(callId, agentId))
    );
    this.keyRecords.set(key, { fingerprint, result });
    return result;
  }

  snapshot(): Snapshot {
    const calls = [...this.calls.entries()].map(([callId, agentId]) => ({
      callId,
      agentId,
    }));
    const agentCalls: Record<AgentId, CallId> = {};
    for (const [agentId, callId] of this.agentCall) agentCalls[agentId] = callId;
    return { calls, agentCalls };
  }

  private doOpenCall(agentId: AgentId): OpenCallResult {
    if (this.agentCall.has(agentId)) return { ok: false, error: "AGENT_BUSY" };
    const callId = `call-${this.nextCallSeq++}`;
    this.calls.set(callId, agentId);
    this.agentCall.set(agentId, callId);
    return { ok: true, callId };
  }

  private async doTransferCall(
    callId: CallId,
    fromAgentId: AgentId,
    toAgentId: AgentId
  ): Promise<TransferCallResult> {
    const owner = this.calls.get(callId);
    if (owner === undefined) return { ok: false, error: "CALL_NOT_FOUND" };
    if (owner !== fromAgentId) return { ok: false, error: "NOT_OWNER" };
    if (fromAgentId === toAgentId) return { ok: false, error: "SAME_AGENT" };
    if (this.agentCall.has(toAgentId)) return { ok: false, error: "TARGET_BUSY" };
    try {
      await this.handoff(callId, fromAgentId, toAgentId);
    } catch {
      return { ok: false, error: "HANDOFF_FAILED" };
    }
    this.calls.set(callId, toAgentId);
    this.agentCall.delete(fromAgentId);
    this.agentCall.set(toAgentId, callId);
    return { ok: true };
  }

  private doCloseCall(callId: CallId, agentId: AgentId): CloseCallResult {
    const owner = this.calls.get(callId);
    if (owner === undefined) return { ok: false, error: "CALL_NOT_FOUND" };
    if (owner !== agentId) return { ok: false, error: "NOT_OWNER" };
    this.calls.delete(callId);
    this.agentCall.delete(agentId);
    return { ok: true };
  }

  private enqueue<R>(resources: string[], body: () => Promise<R>): Promise<R> {
    const predecessors: Promise<unknown>[] = [];
    for (const resource of resources) {
      const tail = this.resourceTails.get(resource);
      if (tail) predecessors.push(tail);
    }
    const run = Promise.allSettled(predecessors).then(body);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    for (const resource of resources) this.resourceTails.set(resource, tail);
    for (const resource of resources) {
      void tail.then(() => {
        if (this.resourceTails.get(resource) === tail) {
          this.resourceTails.delete(resource);
        }
      });
    }
    return run;
  }
}

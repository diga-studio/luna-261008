import {
  AgentId,
  CallId,
  CloseResult,
  Failure,
  FailureCode,
  HandoffFn,
  Key,
  OpenResult,
  Snapshot,
  TransferResult,
} from "./types";

interface KeyRecord {
  fingerprint: string;
  promise: Promise<OpenResult | TransferResult | CloseResult>;
}

function fail(code: FailureCode, message: string): Failure {
  return { ok: false, code, message };
}

/**
 * In-process call ownership registry.
 *
 * Concurrency model: every write operation declares the resources it may
 * inspect or mutate (a call id and/or agent ids). Operations whose resource
 * sets intersect are serialized by per-resource promise chains in arrival
 * order; operations with disjoint sets run concurrently. Only transferCall
 * has an await point (the handoff confirmation) between precondition check
 * and commit, and while it waits it holds only its own chain position, so
 * unrelated operations proceed and snapshot() keeps reading committed state.
 */
export class CallOwnership {
  private readonly handoff: HandoffFn;
  private readonly calls = new Map<CallId, AgentId>();
  private readonly agents = new Map<AgentId, CallId>();
  private readonly keyRecords = new Map<Key, KeyRecord>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private callSeq = 0;

  constructor(handoff: HandoffFn) {
    this.handoff = handoff;
  }

  openCall(agentId: AgentId, key: Key): Promise<OpenResult> {
    return this.admit<OpenResult>(
      key,
      `open|${agentId}`,
      [`agent:${agentId}`],
      () => this.execOpen(agentId)
    );
  }

  transferCall(
    callId: CallId,
    fromAgentId: AgentId,
    toAgentId: AgentId,
    key: Key
  ): Promise<TransferResult> {
    return this.admit<TransferResult>(
      key,
      `transfer|${callId}|${fromAgentId}|${toAgentId}`,
      [`call:${callId}`, `agent:${fromAgentId}`, `agent:${toAgentId}`],
      () => this.execTransfer(callId, fromAgentId, toAgentId)
    );
  }

  closeCall(callId: CallId, agentId: AgentId, key: Key): Promise<CloseResult> {
    return this.admit<CloseResult>(
      key,
      `close|${callId}|${agentId}`,
      [`call:${callId}`, `agent:${agentId}`],
      () => this.execClose(callId, agentId)
    );
  }

  snapshot(): Snapshot {
    return { calls: new Map(this.calls), agents: new Map(this.agents) };
  }

  private admit<R extends OpenResult | TransferResult | CloseResult>(
    key: Key,
    fingerprint: string,
    resources: string[],
    exec: () => Promise<R>
  ): Promise<R> {
    const existing = this.keyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(
          fail(
            "KEY_CONFLICT",
            `key "${key}" is already bound to a different operation or parameters`
          ) as R
        );
      }
      return existing.promise as Promise<R>;
    }
    const promise = this.enqueue(resources, exec);
    this.keyRecords.set(key, { fingerprint, promise });
    return promise;
  }

  private enqueue<R>(resources: string[], exec: () => Promise<R>): Promise<R> {
    const sorted = [...new Set(resources)].sort();
    const previous = Promise.all(
      sorted
        .map((resource) => this.lockTails.get(resource))
        .filter((tail): tail is Promise<void> => tail !== undefined)
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    for (const resource of sorted) {
      this.lockTails.set(resource, tail);
    }
    void tail.then(() => {
      for (const resource of sorted) {
        if (this.lockTails.get(resource) === tail) {
          this.lockTails.delete(resource);
        }
      }
    });
    return previous.then(exec).then(
      (result) => {
        release();
        return result;
      },
      (error: unknown) => {
        release();
        throw error;
      }
    );
  }

  private execOpen(agentId: AgentId): Promise<OpenResult> {
    if (this.agents.has(agentId)) {
      return Promise.resolve(
        fail("AGENT_BUSY", `agent "${agentId}" already owns an open call`)
      );
    }
    const callId: CallId = `call-${++this.callSeq}`;
    this.calls.set(callId, agentId);
    this.agents.set(agentId, callId);
    return Promise.resolve({ ok: true, callId });
  }

  private async execTransfer(
    callId: CallId,
    fromAgentId: AgentId,
    toAgentId: AgentId
  ): Promise<TransferResult> {
    const owner = this.calls.get(callId);
    if (owner === undefined) {
      return fail("CALL_NOT_FOUND", `call "${callId}" does not exist`);
    }
    if (owner !== fromAgentId) {
      return fail(
        "AGENT_NOT_OWNER",
        `call "${callId}" is owned by "${owner}", not "${fromAgentId}"`
      );
    }
    if (toAgentId === fromAgentId) {
      return fail(
        "TARGET_SAME_AS_SOURCE",
        `target agent "${toAgentId}" is the current owner`
      );
    }
    if (this.agents.has(toAgentId)) {
      return fail(
        "TARGET_BUSY",
        `target agent "${toAgentId}" already owns an open call`
      );
    }
    try {
      await this.handoff(callId, fromAgentId, toAgentId);
    } catch (error) {
      return fail(
        "HANDOFF_FAILED",
        `handoff confirmation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    this.calls.set(callId, toAgentId);
    this.agents.delete(fromAgentId);
    this.agents.set(toAgentId, callId);
    return { ok: true, callId, fromAgentId, toAgentId };
  }

  private execClose(callId: CallId, agentId: AgentId): Promise<CloseResult> {
    const owner = this.calls.get(callId);
    if (owner === undefined) {
      return Promise.resolve(
        fail("CALL_NOT_FOUND", `call "${callId}" does not exist`)
      );
    }
    if (owner !== agentId) {
      return Promise.resolve(
        fail(
          "AGENT_NOT_OWNER",
          `call "${callId}" is owned by "${owner}", not "${agentId}"`
        )
      );
    }
    this.calls.delete(callId);
    this.agents.delete(agentId);
    return Promise.resolve({ ok: true, callId });
  }
}

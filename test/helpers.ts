import assert from "node:assert/strict";
import type { AgentId, CallId, HandoffFn, OpenCallResult } from "../src/types";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface HandoffInvocation {
  callId: CallId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
}

type Mode = "pause" | "success" | "fail";

export class ManualHandoff {
  readonly invocations: HandoffInvocation[] = [];
  readonly fn: HandoffFn;
  private mode: Mode = "pause";
  private gates: Deferred<void>[] = [];
  private waiters: Array<(inv: HandoffInvocation) => void> = [];

  constructor() {
    this.fn = (callId, fromAgentId, toAgentId) => {
      const inv = { callId, fromAgentId, toAgentId };
      this.invocations.push(inv);
      for (const waiter of this.waiters.splice(0)) waiter(inv);
      if (this.mode === "success") return Promise.resolve();
      if (this.mode === "fail") {
        return Promise.reject(new Error("handoff rejected by test"));
      }
      const gate = deferred<void>();
      this.gates.push(gate);
      return gate.promise;
    };
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  nextInvocation(): Promise<HandoffInvocation> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get pendingCount(): number {
    return this.gates.length;
  }

  releaseAll(): void {
    for (const gate of this.gates.splice(0)) gate.resolve();
  }

  failAll(): void {
    for (const gate of this.gates.splice(0)) {
      gate.reject(new Error("handoff rejected by test"));
    }
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function track<T>(promise: Promise<T>): {
  settled: () => boolean;
  result: Promise<T>;
} {
  let settled = false;
  const result = promise.then((value) => {
    settled = true;
    return value;
  });
  return { settled: () => settled, result };
}

export function mustOpen(result: OpenCallResult): CallId {
  if (!result.ok) assert.fail(`expected openCall to succeed, got ${result.error}`);
  return result.callId;
}

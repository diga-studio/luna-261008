import { AgentId, CallId } from "../src/types";

export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T): void {
    this.resolveFn(value);
  }

  reject(reason?: unknown): void {
    this.rejectFn(reason);
  }
}

export interface HandoffCall {
  callId: CallId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  gate: Deferred<void>;
}

/**
 * A handoff stub whose every invocation is captured and only completes when
 * the test explicitly resolves or rejects the corresponding gate, so tests
 * control interleavings deterministically without any timers.
 */
export class ControllableHandoff {
  readonly calls: HandoffCall[] = [];
  private waiters: Array<{ count: number; gate: Deferred<void> }> = [];

  readonly fn = (callId: CallId, fromAgentId: AgentId, toAgentId: AgentId): Promise<void> => {
    const gate = new Deferred<void>();
    this.calls.push({ callId, fromAgentId, toAgentId, gate });
    this.notify();
    return gate.promise;
  };

  get callCount(): number {
    return this.calls.length;
  }

  /** Resolves once the handoff has been invoked at least `count` times. */
  waitForCallCount(count: number): Promise<void> {
    if (this.calls.length >= count) {
      return Promise.resolve();
    }
    const gate = new Deferred<void>();
    this.waiters.push({ count, gate });
    return gate.promise;
  }

  succeed(index = 0): void {
    this.calls[index].gate.resolve(undefined);
  }

  fail(index = 0, reason: unknown = new Error("handoff rejected")): void {
    this.calls[index].gate.reject(reason);
  }

  private notify(): void {
    this.waiters = this.waiters.filter(({ count, gate }) => {
      if (this.calls.length >= count) {
        gate.resolve(undefined);
        return false;
      }
      return true;
    });
  }
}

/**
 * Deterministically reports whether `p` had already settled at call time,
 * exploiting that Promise.race subscribes to its inputs synchronously and in
 * order: an already-settled first input always wins over a resolved-later
 * second input.
 */
export function wasSettled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    Promise.resolve(false),
  ]);
}

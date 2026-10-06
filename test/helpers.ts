import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverFn } from "../src/index.js";

export interface DeliverCall {
  conversationId: string;
  seq: number;
  messageId: string;
  text: string;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}

/** A deliver function whose promises are settled manually by the test. */
export class DeliverRecorder {
  readonly calls: DeliverCall[] = [];
  /** Optional hook invoked synchronously inside deliver, before it returns. */
  onCall: ((call: DeliverCall) => void) | null = null;

  readonly fn: DeliverFn = (conversationId, seq, messageId, text) => {
    let resolveFn: (value?: unknown) => void = () => undefined;
    let rejectFn: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const call: DeliverCall = {
      conversationId,
      seq,
      messageId,
      text,
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.calls.push(call);
    this.onCall?.(call);
    return promise;
  };

  /** Calls for one conversation, in initiation order. */
  forConversation(conversationId: string): DeliverCall[] {
    return this.calls.filter((c) => c.conversationId === conversationId);
  }

  seqsFor(conversationId: string): number[] {
    return this.forConversation(conversationId).map((c) => c.seq);
  }
}

export function tempDbPath(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  return {
    dir,
    dbPath: join(dir, "relay.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Flush the microtask queue so settled deliver promises run their handlers. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

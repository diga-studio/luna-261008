import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeliverFn } from "../src/index";

export interface DeliveryCall {
  conversationId: string;
  seq: number;
  messageId: string;
  text: string;
  resolve: (value?: unknown) => void;
  reject: (err?: unknown) => void;
}

/** 手动控制完成时机的 deliver mock；hook 在返回 Promise 前同步执行。 */
export class DeliverMock {
  readonly calls: DeliveryCall[] = [];
  /** 同步重入钩子：在 deliver 返回 Promise 之前调用。 */
  hook: ((call: DeliveryCall) => void) | null = null;

  readonly fn: DeliverFn = (conversationId, seq, messageId, text) => {
    let resolveFn: (value?: unknown) => void = () => undefined;
    let rejectFn: (err?: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const call: DeliveryCall = {
      conversationId,
      seq,
      messageId,
      text,
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.calls.push(call);
    if (this.hook !== null) {
      this.hook(call);
    }
    return promise;
  };

  callsFor(conversationId: string, seq: number): DeliveryCall[] {
    return this.calls.filter((c) => c.conversationId === conversationId && c.seq === seq);
  }
}

export function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
  return path.join(dir, "test.db");
}

/** 让已挂载的 Promise 回调（then/catch）有机会执行。 */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

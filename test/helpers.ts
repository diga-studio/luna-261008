import { promises as fs } from "node:fs";
import * as path from "node:path";
import { RunStage, StageName } from "../src/types";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface StageCall {
  jobId: string;
  stage: StageName;
  inputPath: string;
  workDir: string;
  signal: AbortSignal;
  /** 让阶段成功：在 workDir 里真实写入产物文件并以其路径解决 */
  succeed: (content?: string) => Promise<void>;
  /** 让阶段失败 */
  fail: (err: unknown) => void;
  /** 触发进度回调（可在阶段结束后调用，模拟迟到进度） */
  progress: (value: number) => void;
  /** 阶段 Promise 是否已结束 */
  settled: boolean;
  done: Promise<void>;
}

export class StageHarness {
  readonly calls: StageCall[] = [];
  private waiters: Array<{
    pred: (c: StageCall) => boolean;
    resolve: (c: StageCall) => void;
  }> = [];

  readonly runStage: RunStage = (
    jobId,
    stage,
    inputPath,
    workDir,
    signal,
    onProgress
  ) => {
    const gate = deferred<string>();
    const call: StageCall = {
      jobId,
      stage,
      inputPath,
      workDir,
      signal,
      settled: false,
      succeed: async (content = `${jobId}-${stage}-artifact`) => {
        const artifactPath = path.join(workDir, `${stage}.out`);
        await fs.writeFile(artifactPath, content);
        gate.resolve(artifactPath);
        await call.done;
      },
      fail: (err) => {
        gate.reject(err);
      },
      progress: (value) => {
        onProgress(value);
      },
      done: Promise.resolve(),
    };
    call.done = gate.promise.then(
      () => undefined,
      () => undefined
    );
    void gate.promise.then(
      () => {
        call.settled = true;
      },
      () => {
        call.settled = true;
      }
    );
    this.calls.push(call);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.pred(call)) {
        this.waiters.splice(i, 1);
        w.resolve(call);
      }
    }
    return gate.promise;
  };

  callsFor(jobId: string, stage?: StageName): StageCall[] {
    return this.calls.filter(
      (c) => c.jobId === jobId && (stage === undefined || c.stage === stage)
    );
  }

  waitForCall(jobId: string, stage: StageName): Promise<StageCall> {
    const existing = this.callsFor(jobId, stage)[0];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.push({
        pred: (c) => c.jobId === jobId && c.stage === stage,
        resolve,
      });
    });
  }

  waitForCallCount(n: number): Promise<void> {
    if (this.calls.length >= n) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.calls.length >= n) resolve();
        else this.waiters.push({ pred: () => this.calls.length >= n, resolve: () => check() });
      };
      check();
    });
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function makeInputFile(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, `input-${name}`);
  return p;
}

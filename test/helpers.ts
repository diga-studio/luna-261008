import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunStage, Stage, ProgressCallback } from '../src/types.ts';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (err: unknown) => void;
}

export function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve as (value?: T) => void, reject };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(join(tmpdir(), prefix));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

export interface StageCall {
  jobId: string;
  stage: Stage;
  inputPath: string;
  workDir: string;
  signal: AbortSignal;
  progress: ProgressCallback;
}

export type StageHandler = (call: StageCall) => Promise<string>;

export async function writeArtifact(workDir: string, name: string, content: string): Promise<string> {
  const p = join(workDir, name);
  await fsp.writeFile(p, content);
  return p;
}

export class StageDriver {
  readonly calls: StageCall[] = [];
  private handlers = new Map<string, StageHandler>();
  private defaultHandler: StageHandler | null = null;
  private startWaiters: Array<{ n: number; d: Deferred<StageCall[]> }> = [];

  setHandler(jobId: string, stage: Stage, handler: StageHandler): void {
    this.handlers.set(`${jobId}:${stage}`, handler);
  }

  setDefault(handler: StageHandler): void {
    this.defaultHandler = handler;
  }

  waitForStarts(n: number): Promise<StageCall[]> {
    if (this.calls.length >= n) return Promise.resolve(this.calls.slice(0, n));
    const d = defer<StageCall[]>();
    this.startWaiters.push({ n, d });
    return d.promise;
  }

  readonly runStage: RunStage = (jobId, stage, inputPath, workDir, signal, progress) => {
    const call: StageCall = { jobId, stage, inputPath, workDir, signal, progress };
    this.calls.push(call);
    for (const w of this.startWaiters) {
      if (this.calls.length >= w.n) w.d.resolve(this.calls.slice(0, w.n));
    }
    this.startWaiters = this.startWaiters.filter((w) => this.calls.length < w.n);
    const handler = this.handlers.get(`${jobId}:${stage}`) ?? this.defaultHandler;
    if (!handler) return Promise.reject(new Error(`no handler for ${jobId}:${stage}`));
    return handler(call);
  };
}

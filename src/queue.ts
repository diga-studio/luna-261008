import { join, extname } from 'node:path';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { STAGES } from './types.ts';
import type {
  JobStatus,
  Priority,
  RenderQueueOptions,
  RunStage,
  Snapshot,
  Stage,
} from './types.ts';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);

interface Job {
  readonly id: string;
  readonly inputPath: string;
  readonly seq: number;
  priority: Priority;
  status: JobStatus;
  stage: Stage | null;
  progress: number | null;
  stageToken: number;
  readonly controller: AbortController;
  workDir: string | null;
  outputPath: string | null;
}

export class RenderQueue {
  private readonly runStage: RunStage;
  private readonly outputDir: string;
  private readonly workRoot: string;
  private readonly slots: number;
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: Job[] = [];
  private readonly active = new Set<Job>();
  private readonly idleWaiters: Array<() => void> = [];
  private outputDirReady: Promise<unknown> | null = null;
  private seqCounter = 0;
  private idCounter = 0;

  constructor(options: RenderQueueOptions) {
    this.runStage = options.runStage;
    this.outputDir = options.outputDir;
    this.workRoot = options.workRoot;
    this.slots = options.slots ?? 10;
  }

  submit(inputPath: string, priority: Priority): string {
    const id = `job-${++this.idCounter}`;
    const job: Job = {
      id,
      inputPath,
      seq: this.seqCounter++,
      priority,
      status: 'queued',
      stage: null,
      progress: null,
      stageToken: 0,
      controller: new AbortController(),
      workDir: null,
      outputPath: null,
    };
    this.jobs.set(id, job);
    this.waiting.push(job);
    this.schedule();
    return id;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return false;
    const idx = this.waiting.indexOf(job);
    if (idx >= 0) this.waiting.splice(idx, 1);
    job.status = 'cancelled';
    job.stage = null;
    job.progress = null;
    job.stageToken++;
    job.controller.abort();
    this.checkIdle();
    return true;
  }

  reprioritize(id: string, priority: Priority): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    job.priority = priority;
    return true;
  }

  snapshot(id: string): Snapshot {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    const running = job.status === 'running';
    const snap: Snapshot = {
      status: job.status,
      stage: running ? job.stage : null,
      stageProgress: running ? job.progress : null,
    };
    if (job.status === 'completed' && job.outputPath !== null) {
      (snap as { outputPath?: string }).outputPath = job.outputPath;
    }
    return snap;
  }

  drain(): Promise<void> {
    if (this.waiting.length === 0 && this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private schedule(): void {
    while (this.active.size < this.slots && this.waiting.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        const cand = this.waiting[i]!;
        const best = this.waiting[bestIdx]!;
        if (
          PRIORITY_RANK[cand.priority] < PRIORITY_RANK[best.priority] ||
          (PRIORITY_RANK[cand.priority] === PRIORITY_RANK[best.priority] && cand.seq < best.seq)
        ) {
          bestIdx = i;
        }
      }
      const [job] = this.waiting.splice(bestIdx, 1);
      this.active.add(job!);
      void this.runJob(job!);
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      job.status = 'running';
      job.workDir = join(this.workRoot, job.id);
      await fsp.mkdir(job.workDir, { recursive: true });
      let input = job.inputPath;
      for (const stage of STAGES) {
        if (job.status !== 'running') return;
        job.stage = stage;
        job.progress = null;
        const token = ++job.stageToken;
        const onProgress = (p: number): void => {
          if (job.stageToken === token && job.status === 'running') {
            job.progress = p;
          }
        };
        let artifact: string;
        try {
          artifact = await this.runStage(
            job.id,
            stage,
            input,
            job.workDir,
            job.controller.signal,
            onProgress,
          );
        } catch {
          if (job.status === 'running') job.status = 'failed';
          return;
        }
        if (job.status !== 'running') return;
        input = artifact;
      }
      await this.ensureOutputDir();
      const outPath = join(this.outputDir, `${job.id}${extname(input)}`);
      try {
        await pipeline(createReadStream(input), createWriteStream(outPath));
        await fsp.access(outPath);
      } catch {
        if (job.status === 'running') job.status = 'failed';
        return;
      }
      if (job.status !== 'running') {
        await fsp.rm(outPath, { force: true }).catch(() => undefined);
        return;
      }
      job.outputPath = outPath;
      job.status = 'completed';
    } catch {
      if (job.status === 'running') job.status = 'failed';
    } finally {
      job.stage = null;
      job.progress = null;
      if (job.workDir !== null) {
        await fsp.rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.active.delete(job);
      this.schedule();
      this.checkIdle();
    }
  }

  private ensureOutputDir(): Promise<unknown> {
    this.outputDirReady ??= fsp.mkdir(this.outputDir, { recursive: true });
    return this.outputDirReady;
  }

  private checkIdle(): void {
    if (this.waiting.length === 0 && this.active.size === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

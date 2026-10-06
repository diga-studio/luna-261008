import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JobSnapshot,
  JobStatus,
  Priority,
  RenderQueue,
  RenderQueueOptions,
  StageName,
  STAGES,
} from "./types";

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const DEFAULT_SLOTS = 10;

interface Job {
  id: string;
  inputPath: string;
  priority: Priority;
  submitSeq: number;
  status: JobStatus;
  stage: StageName | null;
  progress: number | null;
  outputPath: string | null;
  error: string | null;
  abort: AbortController;
  workDir: string | null;
}

export function createRenderQueue(options: RenderQueueOptions): RenderQueue {
  const runStage = options.runStage;
  const slotCount = options.slots ?? DEFAULT_SLOTS;
  const outputDir =
    options.outputDir ??
    path.join(os.tmpdir(), `render-queue-output-${process.pid}-${Date.now()}`);
  const workRoot =
    options.workRoot ??
    path.join(os.tmpdir(), `render-queue-work-${process.pid}-${Date.now()}`);
  const beforePublish = options.hooks?.beforePublish;
  const afterCleanup = options.hooks?.afterCleanup;

  const jobs = new Map<string, Job>();
  const waiting: Job[] = [];
  let slotsInUse = 0;
  let seq = 0;
  let idCounter = 0;

  const dirsReady = (async () => {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(workRoot, { recursive: true });
  })();

  function isTerminal(job: Job): boolean {
    return (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    );
  }

  function finalize(
    job: Job,
    status: "completed" | "failed" | "cancelled",
    patch?: Partial<Pick<Job, "outputPath" | "error">>
  ): boolean {
    if (isTerminal(job)) return false;
    job.status = status;
    job.progress = null;
    if (patch?.outputPath !== undefined) job.outputPath = patch.outputPath;
    if (patch?.error !== undefined) job.error = patch.error;
    return true;
  }

  function pickNext(): Job | undefined {
    let bestIdx = -1;
    for (let i = 0; i < waiting.length; i++) {
      const candidate = waiting[i]!;
      const best = waiting[bestIdx];
      if (
        bestIdx === -1 ||
        PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[best!.priority] ||
        (PRIORITY_RANK[candidate.priority] === PRIORITY_RANK[best!.priority] &&
          candidate.submitSeq < best!.submitSeq)
      ) {
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return undefined;
    return waiting.splice(bestIdx, 1)[0];
  }

  function pump(): void {
    while (slotsInUse < slotCount) {
      const next = pickNext();
      if (!next) return;
      if (next.status !== "queued") continue;
      slotsInUse++;
      next.status = "running";
      void runJob(next).finally(() => {
        slotsInUse--;
        pump();
      });
    }
  }

  async function runJob(job: Job): Promise<void> {
    await dirsReady;
    const workDir = path.join(workRoot, job.id);
    job.workDir = workDir;
    await fs.mkdir(workDir, { recursive: true });

    let currentInput = job.inputPath;
    let artifact: string | null = null;

    for (const stage of STAGES) {
      if (isTerminal(job)) break;
      job.stage = stage;
      job.progress = null;
      const onProgress = (value: number) => {
        // 迟到回调：阶段已前进或作业已终态时直接丢弃
        if (isTerminal(job)) return;
        if (job.stage !== stage) return;
        job.progress = value;
      };
      try {
        artifact = await runStage(
          job.id,
          stage,
          currentInput,
          workDir,
          job.abort.signal,
          onProgress
        );
      } catch (err) {
        // 取消后迟到的抛错不得改写终态
        if (!isTerminal(job)) {
          finalize(job, "failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      // 取消后迟到的成功结果不得改写终态；产物随 workDir 一并清理
      if (isTerminal(job)) break;
      currentInput = artifact;
    }

    if (!isTerminal(job) && artifact !== null) {
      const finalName = `${job.id}-${path.basename(artifact)}`;
      const finalPath = path.join(outputDir, finalName);
      try {
        if (beforePublish) await beforePublish(job.id);
        await fs.copyFile(artifact, finalPath);
      } catch (err) {
        if (!isTerminal(job)) {
          finalize(job, "failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!isTerminal(job)) {
        // 成品已落盘可读，completed 此刻才可见
        finalize(job, "completed", { outputPath: finalPath });
      } else {
        // 发布期间被取消：迟到落盘的成品不得暴露，清除之
        await fs.rm(finalPath, { force: true }).catch(() => undefined);
      }
    }

    // 收尾 I/O：清理工作目录（不触碰原始输入）；槽位在此之后才归还
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (afterCleanup) afterCleanup(job.id);
  }

  return {
    submit(inputPath: string, priority: Priority): string {
      const id = `job-${++idCounter}`;
      const job: Job = {
        id,
        inputPath,
        priority,
        submitSeq: seq++,
        status: "queued",
        stage: null,
        progress: null,
        outputPath: null,
        error: null,
        abort: new AbortController(),
        workDir: null,
      };
      jobs.set(id, job);
      waiting.push(job);
      pump();
      return id;
    },

    cancel(id: string): boolean {
      const job = jobs.get(id);
      if (!job || isTerminal(job)) return false;
      if (job.status === "queued") {
        const idx = waiting.indexOf(job);
        if (idx !== -1) waiting.splice(idx, 1);
      }
      finalize(job, "cancelled");
      job.abort.abort();
      return true;
    },

    reprioritize(id: string, priority: Priority): boolean {
      const job = jobs.get(id);
      if (!job || job.status !== "queued") return false;
      job.priority = priority;
      return true;
    },

    snapshot(id: string): JobSnapshot | null {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        id: job.id,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        outputPath: job.status === "completed" ? job.outputPath : null,
        error: job.error,
      };
    },
  };
}

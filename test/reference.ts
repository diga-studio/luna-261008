/**
 * 独立参照实现：直接按业务规则用数组从头计算，用于对照引擎结果。
 * 不追求性能，只追求规则表达直白。
 */
import {
  JobChanges,
  MachineConfig,
  ProcessingGrade,
  QueuePosition,
} from '../src/index.js';

const MULTIPLIER_X2: Record<ProcessingGrade, number> = {
  normal: 2,
  lamination: 3,
  diecut: 4,
};

interface RefJob {
  id: string;
  machineId: string;
  priority: number;
  sheets: number;
  grade: ProcessingGrade;
  /** 进入当前印机队列的先后序号。 */
  seq: number;
}

export class ReferenceQueue {
  private readonly configs = new Map<string, MachineConfig>();
  private readonly jobs = new Map<string, RefJob>();
  private readonly seqCounters = new Map<string, number>();

  constructor(machines: readonly MachineConfig[]) {
    for (const config of machines) {
      this.configs.set(config.id, config);
      this.seqCounters.set(config.id, 0);
    }
  }

  addJob(
    jobId: string,
    machineId: string,
    priority: number,
    sheets: number,
    grade: ProcessingGrade,
  ): void {
    const seq = this.seqCounters.get(machineId) ?? 0;
    this.seqCounters.set(machineId, seq + 1);
    this.jobs.set(jobId, { id: jobId, machineId, priority, sheets, grade, seq });
  }

  updateJob(jobId: string, changes: JobChanges): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error(`unknown job ${jobId}`);
    if (changes.priority !== undefined) job.priority = changes.priority;
    if (changes.sheets !== undefined) job.sheets = changes.sheets;
    if (changes.grade !== undefined) job.grade = changes.grade;
    if (changes.machineId !== undefined && changes.machineId !== job.machineId) {
      job.machineId = changes.machineId;
      const seq = this.seqCounters.get(job.machineId) ?? 0;
      this.seqCounters.set(job.machineId, seq + 1);
      job.seq = seq;
    }
  }

  removeJob(jobId: string): void {
    this.jobs.delete(jobId);
  }

  /** 单作业耗时：上机张数 × 倍数 × 3600 / 产能，向上取整。 */
  durationOf(job: RefJob): number {
    const capacity = this.configs.get(job.machineId)?.sheetsPerHour ?? 1;
    const numerator = BigInt(job.sheets) * BigInt(MULTIPLIER_X2[job.grade]) * 3600n;
    const denominator = BigInt(capacity) * 2n;
    return Number((numerator + denominator - 1n) / denominator);
  }

  queryJob(jobId: string): QueuePosition {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error(`unknown job ${jobId}`);
    const config = this.configs.get(job.machineId);
    if (config === undefined) throw new Error(`unknown machine ${job.machineId}`);

    const queue = [...this.jobs.values()]
      .filter((other) => other.machineId === job.machineId)
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    let elapsed = 0;
    let position = 0;
    for (const current of queue) {
      position += 1;
      if (current.id === jobId) {
        const duration = this.durationOf(current);
        return {
          position,
          startAt: config.availableFrom + elapsed,
          completeAt: config.availableFrom + elapsed + duration,
          duration,
          machineId: job.machineId,
        };
      }
      elapsed += this.durationOf(current);
    }
    throw new Error(`job ${jobId} not in queue`);
  }
}

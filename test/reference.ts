/**
 * 独立参照实现：每次查询都按业务规则从头计算。
 * 刻意使用与被测实现不同的朴素算法（数组 + 排序 + 顺序累加），
 * 用于交叉验证队列顺序与逐作业取整后的累计工期。
 */
import {
  AddJobInput,
  Grade,
  JobStatus,
  MachineSpec,
  UpdateJobInput,
} from '../src/types';

const GRADE_MULTIPLIER: Record<Grade, number> = {
  normal: 1,
  lamination: 1.5,
  diecut: 2,
};

interface RefJob {
  id: string;
  machineId: string;
  priority: number;
  seq: number;
  sheets: number;
  grade: Grade;
}

export class ReferenceScheduler {
  private readonly specs = new Map<string, MachineSpec>();
  private readonly jobs = new Map<string, RefJob>();
  private seqCounter = 0;

  constructor(machines: readonly MachineSpec[]) {
    for (const spec of machines) {
      this.specs.set(spec.id, spec);
    }
  }

  addJob(input: AddJobInput): void {
    this.seqCounter += 1;
    this.jobs.set(input.id, {
      id: input.id,
      machineId: input.machineId,
      priority: input.priority,
      seq: this.seqCounter,
      sheets: input.sheets,
      grade: input.grade,
    });
  }

  updateJob(id: string, patch: UpdateJobInput): void {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new Error(`unknown job: ${id}`);
    }
    if (patch.machineId !== undefined && patch.machineId !== job.machineId) {
      this.seqCounter += 1;
      job.seq = this.seqCounter;
      job.machineId = patch.machineId;
    }
    if (patch.priority !== undefined) job.priority = patch.priority;
    if (patch.sheets !== undefined) job.sheets = patch.sheets;
    if (patch.grade !== undefined) job.grade = patch.grade;
  }

  removeJob(id: string): void {
    this.jobs.delete(id);
  }

  query(id: string): JobStatus {
    const target = this.jobs.get(id);
    if (target === undefined) {
      throw new Error(`unknown job: ${id}`);
    }
    const spec = this.specs.get(target.machineId);
    if (spec === undefined) {
      throw new Error(`unknown machine: ${target.machineId}`);
    }
    const queue: RefJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.machineId === target.machineId) {
        queue.push(job);
      }
    }
    queue.sort((a, b) =>
      a.priority === b.priority ? a.seq - b.seq : a.priority - b.priority,
    );
    let clock = spec.availableAt;
    let position = 0;
    for (const job of queue) {
      position += 1;
      const duration = refDuration(spec, job.sheets, job.grade);
      if (job.id === id) {
        return {
          id,
          machineId: job.machineId,
          position,
          startAt: clock,
          finishAt: clock + duration,
        };
      }
      clock += duration;
    }
    throw new Error(`job not in queue: ${id}`);
  }
}

function refDuration(spec: MachineSpec, sheets: number, grade: Grade): number {
  return Math.ceil((sheets * GRADE_MULTIPLIER[grade] * 3600) / spec.sheetsPerHour);
}

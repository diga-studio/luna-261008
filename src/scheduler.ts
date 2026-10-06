import { erase, insert, makeNode, prefixSumOf, rankOf, TreapNode } from './treap';
import {
  AddJobInput,
  Grade,
  JobStatus,
  MachineSpec,
  UpdateJobInput,
} from './types';

/** 加工档倍数，以半档为单位避免浮点：普通 1 倍、覆膜 1.5 倍、模切 2 倍 */
const GRADE_HALVES: Record<Grade, number> = {
  normal: 2,
  lamination: 3,
  diecut: 4,
};

interface MachineState {
  readonly spec: MachineSpec;
  root: TreapNode | null;
}

interface JobEntry {
  node: TreapNode;
  machineId: string;
  sheets: number;
  grade: Grade;
}

export class Scheduler {
  private readonly machines = new Map<string, MachineState>();
  private readonly jobs = new Map<string, JobEntry>();
  private seqCounter = 0;

  constructor(machines: readonly MachineSpec[]) {
    for (const spec of machines) {
      if (this.machines.has(spec.id)) {
        throw new Error(`duplicate machine id: ${spec.id}`);
      }
      if (!Number.isFinite(spec.sheetsPerHour) || spec.sheetsPerHour <= 0) {
        throw new Error(`invalid sheetsPerHour for machine ${spec.id}`);
      }
      if (!Number.isInteger(spec.availableAt)) {
        throw new Error(`invalid availableAt for machine ${spec.id}`);
      }
      this.machines.set(spec.id, { spec, root: null });
    }
  }

  /** 加入等待作业 */
  addJob(input: AddJobInput): void {
    if (this.jobs.has(input.id)) {
      throw new Error(`job already exists: ${input.id}`);
    }
    const machine = this.requireMachine(input.machineId);
    checkPriority(input.priority);
    checkSheets(input.sheets);
    const node = makeNode(
      input.id,
      input.priority,
      this.nextSeq(),
      durationOf(machine.spec, input.sheets, input.grade),
    );
    machine.root = insert(machine.root, node);
    this.jobs.set(input.id, {
      node,
      machineId: input.machineId,
      sheets: input.sheets,
      grade: input.grade,
    });
  }

  /** 修改作业的印机、优先级或加工量 */
  updateJob(id: string, patch: UpdateJobInput): void {
    const entry = this.requireJob(id);
    const targetMachineId = patch.machineId ?? entry.machineId;
    const priority = patch.priority ?? entry.node.prio;
    const sheets = patch.sheets ?? entry.sheets;
    const grade = patch.grade ?? entry.grade;
    const targetMachine = this.requireMachine(targetMachineId);
    checkPriority(priority);
    checkSheets(sheets);

    const oldMachine = this.machines.get(entry.machineId) as MachineState;
    oldMachine.root = erase(oldMachine.root, entry.node);

    if (targetMachineId !== entry.machineId) {
      // 改派：在新印机重新入队，分配新序号
      entry.node.seq = this.nextSeq();
      entry.machineId = targetMachineId;
    }
    entry.node.prio = priority;
    entry.sheets = sheets;
    entry.grade = grade;
    entry.node.duration = durationOf(targetMachine.spec, sheets, grade);
    targetMachine.root = insert(targetMachine.root, entry.node);
  }

  /** 撤出等待作业 */
  removeJob(id: string): void {
    const entry = this.requireJob(id);
    const machine = this.machines.get(entry.machineId) as MachineState;
    machine.root = erase(machine.root, entry.node);
    this.jobs.delete(id);
  }

  /** 查询作业当前的排队位置、预计开始与完成时刻 */
  query(id: string): JobStatus {
    const entry = this.requireJob(id);
    const machine = this.machines.get(entry.machineId) as MachineState;
    const startAt = machine.spec.availableAt + prefixSumOf(entry.node);
    return {
      id,
      machineId: entry.machineId,
      position: rankOf(entry.node) + 1,
      startAt,
      finishAt: startAt + entry.node.duration,
    };
  }

  /** 当前等待作业数 */
  get size(): number {
    return this.jobs.size;
  }

  private nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  private requireMachine(id: string): MachineState {
    const machine = this.machines.get(id);
    if (machine === undefined) {
      throw new Error(`unknown machine: ${id}`);
    }
    return machine;
  }

  private requireJob(id: string): JobEntry {
    const entry = this.jobs.get(id);
    if (entry === undefined) {
      throw new Error(`unknown job: ${id}`);
    }
    return entry;
  }
}

/** 单作业耗时：上机张数 × 加工倍数 × 3600 / 每小时产能，向上取整为整数秒 */
function durationOf(spec: MachineSpec, sheets: number, grade: Grade): number {
  const numerator = sheets * GRADE_HALVES[grade] * 3600;
  return Math.ceil(numerator / (2 * spec.sheetsPerHour));
}

function checkPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new Error(`invalid priority: ${priority}`);
  }
}

function checkSheets(sheets: number): void {
  if (!Number.isInteger(sheets) || sheets < 1 || sheets > 1_000_000) {
    throw new Error(`invalid sheets: ${sheets}`);
  }
}

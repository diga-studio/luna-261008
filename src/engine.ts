import {
  createNode,
  eraseNode,
  insertNode,
  prefixStat,
  TreapKey,
  TreapNode,
} from './treap.js';
import {
  GRADE_MULTIPLIER_X2,
  JobChanges,
  MachineConfig,
  MAX_MACHINES,
  MAX_SHEETS,
  MAX_PRIORITY,
  MIN_PRIORITY,
  ProcessingGrade,
  QueuePosition,
} from './types.js';

interface MachineState {
  readonly config: MachineConfig;
  root: TreapNode | null;
  /** 该印机的入队序号，单调递增，仅用于同级排序。 */
  nextSeq: number;
}

interface JobRecord {
  readonly id: string;
  machineId: string;
  priority: number;
  sheets: number;
  grade: ProcessingGrade;
  key: TreapKey;
  duration: number;
}

/**
 * 单个作业耗时（秒）：上机张数 × 加工倍数 × 3600 / 每小时产能，向上取整。
 * 用 BigInt 做整数运算，避免浮点舍入影响取整边界。
 */
function computeDuration(
  sheets: number,
  grade: ProcessingGrade,
  sheetsPerHour: number,
): number {
  const numerator = BigInt(sheets) * BigInt(GRADE_MULTIPLIER_X2[grade]) * 3600n;
  const denominator = BigInt(sheetsPerHour) * 2n;
  return Number((numerator + denominator - 1n) / denominator);
}

function assertValidPriority(priority: number): void {
  if (
    !Number.isInteger(priority) ||
    priority < MIN_PRIORITY ||
    priority > MAX_PRIORITY
  ) {
    throw new RangeError(
      `priority 必须是 ${MIN_PRIORITY} 到 ${MAX_PRIORITY} 的整数，收到 ${priority}`,
    );
  }
}

function assertValidSheets(sheets: number): void {
  if (!Number.isInteger(sheets) || sheets < 1 || sheets > MAX_SHEETS) {
    throw new RangeError(
      `sheets 必须是 1 到 ${MAX_SHEETS} 的整数，收到 ${sheets}`,
    );
  }
}

/**
 * 印机等待队列引擎：全部数据保存在进程内存中。
 * 调用按顺序发生，不做并发控制。
 */
export class SchedulingEngine {
  private readonly machines = new Map<string, MachineState>();
  private readonly jobs = new Map<string, JobRecord>();
  /** xorshift32 状态，为 Treap 节点提供堆优先级。 */
  private rngState = 0x9e3779b9;

  constructor(machines: readonly MachineConfig[]) {
    if (!Array.isArray(machines) || machines.length < 1) {
      throw new TypeError('至少需要一台印机');
    }
    if (machines.length > MAX_MACHINES) {
      throw new RangeError(`印机数量不能超过 ${MAX_MACHINES}，收到 ${machines.length}`);
    }
    for (const config of machines) {
      if (config === null || typeof config !== 'object') {
        throw new TypeError('印机配置必须是对象');
      }
      if (typeof config.id !== 'string' || config.id.length === 0) {
        throw new TypeError('印机 id 必须是非空字符串');
      }
      if (this.machines.has(config.id)) {
        throw new TypeError(`印机 id 重复：${config.id}`);
      }
      if (!Number.isInteger(config.sheetsPerHour) || config.sheetsPerHour < 1) {
        throw new RangeError(
          `印机 ${config.id} 的 sheetsPerHour 必须是正整数，收到 ${config.sheetsPerHour}`,
        );
      }
      if (!Number.isInteger(config.availableFrom)) {
        throw new RangeError(
          `印机 ${config.id} 的 availableFrom 必须是整数秒，收到 ${config.availableFrom}`,
        );
      }
      this.machines.set(config.id, { config, root: null, nextSeq: 0 });
    }
  }

  /** 加入等待作业。 */
  addJob(
    jobId: string,
    machineId: string,
    priority: number,
    sheets: number,
    grade: ProcessingGrade,
  ): void {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new TypeError('jobId 必须是非空字符串');
    }
    if (this.jobs.has(jobId)) {
      throw new TypeError(`作业已存在：${jobId}`);
    }
    const machine = this.requireMachine(machineId);
    assertValidPriority(priority);
    assertValidSheets(sheets);
    this.assertValidGrade(grade);

    const record: JobRecord = {
      id: jobId,
      machineId,
      priority,
      sheets,
      grade,
      key: { priority, seq: 0 },
      duration: 0,
    };
    this.insertIntoMachine(record, machine);
    this.jobs.set(jobId, record);
  }

  /** 修改作业的印机、优先级或加工量。 */
  updateJob(jobId: string, changes: JobChanges): void {
    const record = this.requireJob(jobId);
    if (changes === null || typeof changes !== 'object') {
      throw new TypeError('changes 必须是对象');
    }
    const machineId = changes.machineId ?? record.machineId;
    const priority = changes.priority ?? record.priority;
    const sheets = changes.sheets ?? record.sheets;
    const grade = changes.grade ?? record.grade;

    const machineChanged = machineId !== record.machineId;
    const machine = machineChanged
      ? this.requireMachine(machineId)
      : this.requireMachine(record.machineId);
    assertValidPriority(priority);
    assertValidSheets(sheets);
    this.assertValidGrade(grade);

    const duration = computeDuration(sheets, grade, machine.config.sheetsPerHour);
    const keyUnchanged =
      !machineChanged && priority === record.priority;
    if (keyUnchanged && duration === record.duration) {
      return;
    }

    // 从旧印机摘除。同机修改保留原 seq；跨机改派在新印机重新入队。
    const oldMachine = this.requireMachine(record.machineId);
    oldMachine.root = eraseNode(oldMachine.root, record.key);

    record.machineId = machineId;
    record.priority = priority;
    record.sheets = sheets;
    record.grade = grade;
    if (machineChanged) {
      record.key = { priority, seq: 0 };
      this.insertIntoMachine(record, machine);
    } else {
      record.key = { priority, seq: record.key.seq };
      record.duration = duration;
      oldMachine.root = insertNode(
        oldMachine.root,
        createNode(record.key, duration, this.nextHeap()),
      );
    }
  }

  /** 撤出等待作业。 */
  removeJob(jobId: string): void {
    const record = this.requireJob(jobId);
    const machine = this.requireMachine(record.machineId);
    machine.root = eraseNode(machine.root, record.key);
    this.jobs.delete(jobId);
  }

  /** 查询任一等待作业的排队位置、预计开始与完成时刻。 */
  queryJob(jobId: string): QueuePosition {
    const record = this.requireJob(jobId);
    const machine = this.requireMachine(record.machineId);
    const before = prefixStat(machine.root, record.key);
    const startAt = machine.config.availableFrom + before.sum;
    return {
      position: before.count + 1,
      startAt,
      completeAt: startAt + record.duration,
      duration: record.duration,
      machineId: record.machineId,
    };
  }

  /** 当前等待作业总数。 */
  get size(): number {
    return this.jobs.size;
  }

  /** 以新 seq 把作业插入指定印机队列末尾（同级意义上），并计算耗时。 */
  private insertIntoMachine(record: JobRecord, machine: MachineState): void {
    record.duration = computeDuration(
      record.sheets,
      record.grade,
      machine.config.sheetsPerHour,
    );
    record.key = { priority: record.priority, seq: machine.nextSeq };
    machine.nextSeq += 1;
    machine.root = insertNode(
      machine.root,
      createNode(record.key, record.duration, this.nextHeap()),
    );
  }

  private requireMachine(machineId: string): MachineState {
    const machine = this.machines.get(machineId);
    if (machine === undefined) {
      throw new TypeError(`未知印机：${machineId}`);
    }
    return machine;
  }

  private requireJob(jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (record === undefined) {
      throw new TypeError(`未知作业：${jobId}`);
    }
    return record;
  }

  private assertValidGrade(grade: ProcessingGrade): void {
    if (!(grade in GRADE_MULTIPLIER_X2)) {
      throw new RangeError(`未知加工档：${String(grade)}`);
    }
  }

  private nextHeap(): number {
    // xorshift32
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState;
  }
}

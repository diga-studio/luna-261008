import { ApplyResult, Batch, Sink } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";

interface BatchEntry {
  /** 已入账的记录条数（批次内前缀）。 */
  applied: number;
  /** 整批完成后的既有确认。 */
  ack: boolean;
}

interface SinkFileShape {
  totals: Record<string, number>;
  batches: Record<string, BatchEntry>;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** 故障注入钩子：在关键持久化点之后触发，用于模拟进程中断。 */
export interface SinkHooks {
  /** 每入账一条记录并落盘后调用（本次调用内已入账条数从 1 开始）。 */
  afterRecordApplied?: (appliedInThisCall: number, batch: Batch) => void;
  /** 整批入账完成、确认状态已落盘、返回确认之前调用。 */
  beforeAckReturned?: (batch: Batch) => void;
}

/** 基于本地 JSON 文件的接收端：按批次身份去重，逐条入账并落盘。 */
export class FileSink implements Sink {
  private readonly file: string;
  private readonly hooks: SinkHooks;
  private state: SinkFileShape;

  constructor(dir: string, hooks?: SinkHooks) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "sink.json");
    this.hooks = hooks ?? {};
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as SinkFileShape;
    } else {
      this.state = { totals: {}, batches: {} };
    }
    this.state.totals = this.state.totals ?? {};
    this.state.batches = this.state.batches ?? {};
  }

  applyBatch(batch: Batch): ApplyResult {
    let entry = this.state.batches[batch.id];
    if (entry !== undefined && entry.applied >= batch.records.length) {
      // 同批次完成后的重复投递：返回既有确认，不再累加。
      return { ack: entry.ack };
    }
    if (entry === undefined) {
      entry = { applied: 0, ack: false };
      this.state.batches[batch.id] = entry;
    }
    let appliedInThisCall = 0;
    while (entry.applied < batch.records.length) {
      const record = batch.records[entry.applied];
      this.state.totals[record.objectId] =
        (this.state.totals[record.objectId] ?? 0) + record.delta;
      entry.applied += 1;
      appliedInThisCall += 1;
      // 每条入账后立即落盘：进程随时退出也不会丢失已入账前缀。
      writeJsonAtomic(this.file, this.state);
      if (this.hooks.afterRecordApplied !== undefined) {
        this.hooks.afterRecordApplied(appliedInThisCall, batch);
      }
    }
    entry.ack = true;
    writeJsonAtomic(this.file, this.state);
    if (this.hooks.beforeAckReturned !== undefined) {
      this.hooks.beforeAckReturned(batch);
    }
    return { ack: entry.ack };
  }

  totalOf(objectId: string): number {
    return this.state.totals[objectId] ?? 0;
  }
}

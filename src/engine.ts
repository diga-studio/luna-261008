import {
  AdvanceResult,
  Batch,
  BatchProgress,
  ProgressState,
  ProgressStore,
  RoundState,
  Sink,
  SourceRecord,
  SourceStore,
  SyncStatus,
} from "./types";

/** 每次推进中，同一未确认批次最多提交的次数。 */
const MAX_ATTEMPTS_PER_ADVANCE = 4;

/** 同步执行器：按高水位把来源增量分批推进到接收端。 */
export class SyncEngine {
  private readonly source: SourceStore;
  private readonly sink: Sink;
  private readonly progress: ProgressStore;
  private readonly batchSize: number;
  private state: ProgressState;

  constructor(
    source: SourceStore,
    sink: Sink,
    progress: ProgressStore,
    batchSize?: number,
  ) {
    this.source = source;
    this.sink = sink;
    this.progress = progress;
    this.batchSize = batchSize ?? 1000;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error("batchSize must be a positive integer");
    }
    this.state = this.progress.load();
  }

  /**
   * 推进同步。
   *
   * 没有未完成轮次时开启新一轮：固定当前来源上界，按 batchSize 分批。
   * 轮次与批次标识一旦确定便永久不变，恢复时继续处理原上界。
   * 同一未确认批次本次最多提交 MAX_ATTEMPTS_PER_ADVANCE 次；
   * 仍无确认则返回未完成，再次推进或重启后继续原轮次。
   */
  advance(): AdvanceResult {
    if (this.state.round === null) {
      const upperBound = this.source.maxSeq();
      if (upperBound <= this.state.highWater) {
        // 没有新来源记录：不产生新的入账。
        return {
          highWater: this.state.highWater,
          roundCompleted: true,
          batchesAcked: 0,
        };
      }
      this.state.round = this.createRound(this.state.highWater, upperBound);
      this.persist();
    }

    const round = this.state.round;
    let batchesAcked = 0;
    for (const bp of round.batches) {
      if (bp.acked) {
        continue;
      }
      const batch = this.materialize(bp);
      let confirmed = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ADVANCE; attempt += 1) {
        const result = this.sink.applyBatch(batch);
        if (result.ack) {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        this.persist();
        return {
          highWater: this.state.highWater,
          roundCompleted: false,
          batchesAcked,
        };
      }
      bp.acked = true;
      // 批次按顺序处理，水位只推进到已获整批确认的连续前缀。
      this.state.highWater = bp.toSeq;
      batchesAcked += 1;
      this.persist();
    }

    this.state.round = null;
    this.persist();
    return {
      highWater: this.state.highWater,
      roundCompleted: true,
      batchesAcked,
    };
  }

  status(): SyncStatus {
    const round = this.state.round;
    return {
      highWater: this.state.highWater,
      sourceMaxSeq: this.source.maxSeq(),
      round:
        round === null
          ? null
          : {
              upperBound: round.upperBound,
              totalBatches: round.batches.length,
              ackedBatches: round.batches.filter((b) => b.acked).length,
            },
    };
  }

  /** 固定轮次上界并切分批次：批次标识、成员及顺序从此永久不变。 */
  private createRound(highWater: number, upperBound: number): RoundState {
    const records = this.source.readRange(highWater, upperBound);
    const batches: BatchProgress[] = [];
    for (let i = 0; i < records.length; i += this.batchSize) {
      const chunk = records.slice(i, i + this.batchSize);
      const fromSeq = chunk[0].seq;
      const toSeq = chunk[chunk.length - 1].seq;
      batches.push({
        id: batchId(fromSeq, toSeq),
        fromSeq,
        toSeq,
        acked: false,
      });
    }
    return { upperBound, batches };
  }

  /** 按已确定的批次边界从来源重建批次内容。 */
  private materialize(bp: BatchProgress): Batch {
    const records: SourceRecord[] = this.source.readRange(
      bp.fromSeq - 1,
      bp.toSeq,
    );
    if (
      records.length === 0 ||
      records[0].seq !== bp.fromSeq ||
      records[records.length - 1].seq !== bp.toSeq
    ) {
      throw new Error(`source records inconsistent with batch ${bp.id}`);
    }
    return { id: bp.id, fromSeq: bp.fromSeq, toSeq: bp.toSeq, records };
  }

  private persist(): void {
    this.progress.save(this.state);
  }
}

function batchId(fromSeq: number, toSeq: number): string {
  return `batch:${fromSeq}:${toSeq}`;
}

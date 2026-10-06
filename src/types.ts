/** 来源记录：严格递增且不可变的整数顺序号、对象标识、整数增量。 */
export interface SourceRecord {
  seq: number;
  objectId: string;
  delta: number;
}

/** 一个已确定的同步批次：标识、成员及顺序永久不变。 */
export interface Batch {
  id: string;
  fromSeq: number;
  toSeq: number;
  records: SourceRecord[];
}

export interface ApplyResult {
  ack: boolean;
}

/** 追加式来源存储。 */
export interface SourceStore {
  append(record: SourceRecord): void;
  maxSeq(): number;
  /** 读取 (fromExclusive, toInclusive] 范围内的记录，按 seq 升序。 */
  readRange(fromExclusive: number, toInclusive: number): SourceRecord[];
}

/** 接收端：按批次身份去重地累加增量。 */
export interface Sink {
  applyBatch(batch: Batch): ApplyResult;
  totalOf(objectId: string): number;
}

export interface BatchProgress {
  id: string;
  fromSeq: number;
  toSeq: number;
  acked: boolean;
}

/** 一轮同步：上界固定，批次集合固定。 */
export interface RoundState {
  upperBound: number;
  batches: BatchProgress[];
}

export interface ProgressState {
  highWater: number;
  round: RoundState | null;
}

/** 同步进度存储，与来源、目标相互独立。 */
export interface ProgressStore {
  load(): ProgressState;
  save(state: ProgressState): void;
}

export interface AdvanceResult {
  highWater: number;
  /** 当前轮（若有）是否已全部确认。 */
  roundCompleted: boolean;
  /** 本次推进中获得确认的批次数。 */
  batchesAcked: number;
}

export interface RoundStatus {
  upperBound: number;
  totalBatches: number;
  ackedBatches: number;
}

export interface SyncStatus {
  highWater: number;
  sourceMaxSeq: number;
  round: RoundStatus | null;
}

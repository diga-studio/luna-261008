import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { deriveExerciseCurve } from './curve.js';
import {
  BatchHandle,
  BatchOp,
  CommitResult,
  MAX_EXERCISES,
  SEGMENT_COUNT,
  SEGMENT_WEEKS,
  SESSIONS_PER_WEEK,
  SETS_PER_EXERCISE,
  SETS_PER_SEGMENT,
  SETS_PER_SESSION,
  SetKey,
  SetVersion,
  TrainingModule,
  VersionedSetRecord,
  ReadView,
  WEEKS_PER_CYCLE,
} from './types.js';

function setSlot(key: SetKey): number {
  return ((key.week - 1) * SESSIONS_PER_WEEK + (key.session - 1)) * SETS_PER_SESSION + (key.setIndex - 1);
}

function keyId(key: SetKey): string {
  return `${key.exerciseIndex}:${key.week}:${key.session}:${key.setIndex}`;
}

interface PendingBatch {
  employeeId: string;
  batchId: string;
  ops: Map<string, BatchOp>;
  done: boolean;
}

class BatchHandleImpl implements BatchHandle {
  constructor(
    private readonly engine: TrainingModuleImpl,
    private readonly pending: PendingBatch,
  ) {}
  get employeeId(): string {
    return this.pending.employeeId;
  }
  get batchId(): string {
    return this.pending.batchId;
  }
  add(op: BatchOp): void {
    if (this.pending.done) throw new Error(`batch ${this.batchId} already finished`);
    this.engine.validateOp(this.pending.employeeId, op);
    this.pending.ops.set(keyId(op.key), op);
  }
  commit(): Promise<CommitResult> {
    if (this.pending.done) throw new Error(`batch ${this.batchId} already finished`);
    this.pending.done = true;
    return this.engine.commitBatch(this.pending);
  }
  abort(): void {
    this.pending.done = true;
    this.engine.discardBatch(this.pending);
  }
}

class ReadViewImpl implements ReadView {
  private closed = false;
  constructor(
    private readonly engine: TrainingModuleImpl,
    readonly employeeId: string,
    readonly commitSeq: number,
    private readonly exerciseCount: number,
  ) {}
  private ensureOpen(): void {
    if (this.closed) throw new Error('read view is closed');
  }
  readSegmentSets(exerciseIndex: number, segmentIndex: number): (VersionedSetRecord | null)[] {
    this.ensureOpen();
    if (segmentIndex < 0 || segmentIndex >= SEGMENT_COUNT) {
      throw new Error(`segmentIndex out of range: ${segmentIndex}`);
    }
    return this.engine.readSegmentSets(this.employeeId, this.commitSeq, exerciseIndex, segmentIndex);
  }
  readCurve(): number[][] {
    this.ensureOpen();
    const curves: number[][] = [];
    for (let ex = 1; ex <= this.exerciseCount; ex++) {
      curves.push(this.engine.deriveCurveAt(this.employeeId, this.commitSeq, ex));
    }
    return curves;
  }
  close(): void {
    this.closed = true;
  }
}

/** Main library entry point. One instance per SQLite database file. */
export class TrainingModuleImpl implements TrainingModule {
  private readonly pendingBatches = new Map<string, PendingBatch>();
  private readonly commitQueues = new Map<string, Promise<void>>();
  private readonly stmtCycleInsert: StatementSync;
  private readonly stmtCycleGet: StatementSync;
  private readonly stmtCommitByBatch: StatementSync;
  private readonly stmtMaxCommit: StatementSync;
  private readonly stmtSetVersion: StatementSync;
  private readonly stmtInsertCommit: StatementSync;
  private readonly stmtInsertHistory: StatementSync;
  private readonly stmtSegment: StatementSync;
  private readonly stmtExercise: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.stmtCycleInsert = db.prepare('INSERT INTO cycles (employee_id, exercise_count) VALUES (?, ?)');
    this.stmtCycleGet = db.prepare('SELECT exercise_count FROM cycles WHERE employee_id = ?');
    this.stmtCommitByBatch = db.prepare(
      'SELECT id, content_hash, credential FROM commits WHERE employee_id = ? AND batch_id = ?',
    );
    this.stmtMaxCommit = db.prepare('SELECT MAX(id) AS seq FROM commits WHERE employee_id = ?');
    this.stmtSetVersion = db.prepare(
      `SELECT MAX(commit_id) AS v FROM set_history
       WHERE employee_id = ? AND exercise_index = ? AND week = ? AND session = ? AND set_index = ?`,
    );
    this.stmtInsertCommit = db.prepare(
      'INSERT INTO commits (employee_id, batch_id, content_hash, credential) VALUES (?, ?, ?, ?)',
    );
    this.stmtInsertHistory = db.prepare(
      `INSERT INTO set_history
         (commit_id, employee_id, exercise_index, week, session, set_index, weight_lbs, reps, withdrawn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSegment = db.prepare(
      `SELECT week, session, set_index, weight_lbs, reps, commit_id FROM (
         SELECT week, session, set_index, weight_lbs, reps, commit_id, withdrawn,
                ROW_NUMBER() OVER (
                  PARTITION BY week, session, set_index ORDER BY commit_id DESC
                ) AS rn
         FROM set_history
         WHERE employee_id = ? AND exercise_index = ? AND week BETWEEN ? AND ? AND commit_id <= ?
       ) WHERE rn = 1 AND withdrawn = 0`,
    );
    this.stmtExercise = db.prepare(
      `SELECT week, session, set_index, weight_lbs, reps FROM (
         SELECT week, session, set_index, weight_lbs, reps, commit_id, withdrawn,
                ROW_NUMBER() OVER (
                  PARTITION BY week, session, set_index ORDER BY commit_id DESC
                ) AS rn
         FROM set_history
         WHERE employee_id = ? AND exercise_index = ? AND commit_id <= ?
       ) WHERE rn = 1 AND withdrawn = 0`,
    );
  }

  createCycle(employeeId: string, exerciseCount: number): void {
    if (!Number.isInteger(exerciseCount) || exerciseCount < 1 || exerciseCount > MAX_EXERCISES) {
      throw new Error(`exerciseCount must be an integer in 1..${MAX_EXERCISES}`);
    }
    const existing = this.stmtCycleGet.get(employeeId);
    if (existing) {
      if (existing.exercise_count !== exerciseCount) {
        throw new Error(`cycle for employee ${employeeId} already exists with ${existing.exercise_count} exercises`);
      }
      return;
    }
    this.stmtCycleInsert.run(employeeId, exerciseCount);
  }

  beginBatch(employeeId: string, batchId: string): BatchHandle {
    this.exerciseCountOf(employeeId);
    const id = `${employeeId}¨${batchId}`;
    if (this.pendingBatches.has(id)) {
      throw new Error(`batch ${batchId} for employee ${employeeId} is already open`);
    }
    const pending: PendingBatch = { employeeId, batchId, ops: new Map(), done: false };
    this.pendingBatches.set(id, pending);
    return new BatchHandleImpl(this, pending);
  }

  openView(employeeId: string): ReadView {
    const exerciseCount = this.exerciseCountOf(employeeId);
    const row = this.stmtMaxCommit.get(employeeId);
    const seq = row && row.seq !== null ? Number(row.seq) : 0;
    return new ReadViewImpl(this, employeeId, seq, exerciseCount);
  }

  close(): void {
    this.db.close();
  }

  // ---- internal helpers used by handles/views ----

  private exerciseCountOf(employeeId: string): number {
    const row = this.stmtCycleGet.get(employeeId);
    if (!row) throw new Error(`no training cycle for employee ${employeeId}`);
    return Number(row.exercise_count);
  }

  validateOp(employeeId: string, op: BatchOp): void {
    const exerciseCount = this.exerciseCountOf(employeeId);
    const { key } = op;
    if (!Number.isInteger(key.exerciseIndex) || key.exerciseIndex < 1 || key.exerciseIndex > exerciseCount) {
      throw new Error(`exerciseIndex out of range: ${key.exerciseIndex}`);
    }
    if (!Number.isInteger(key.week) || key.week < 1 || key.week > WEEKS_PER_CYCLE) {
      throw new Error(`week out of range: ${key.week}`);
    }
    if (!Number.isInteger(key.session) || key.session < 1 || key.session > SESSIONS_PER_WEEK) {
      throw new Error(`session out of range: ${key.session}`);
    }
    if (!Number.isInteger(key.setIndex) || key.setIndex < 1 || key.setIndex > SETS_PER_SESSION) {
      throw new Error(`setIndex out of range: ${key.setIndex}`);
    }
    if (!Number.isInteger(op.baseVersion) || op.baseVersion < 0) {
      throw new Error(`invalid baseVersion: ${op.baseVersion}`);
    }
    if (op.kind === 'upsert') {
      if (!(op.weightLbs > 0)) throw new Error(`invalid weightLbs: ${op.weightLbs}`);
      if (!Number.isInteger(op.reps) || op.reps < 0) throw new Error(`invalid reps: ${op.reps}`);
    }
  }

  discardBatch(pending: PendingBatch): void {
    this.pendingBatches.delete(`${pending.employeeId}¨${pending.batchId}`);
  }

  commitBatch(pending: PendingBatch): Promise<CommitResult> {
    this.discardBatch(pending);
    const { employeeId } = pending;
    const prev = this.commitQueues.get(employeeId) ?? Promise.resolve();
    const result = prev.then(() => this.doCommit(pending));
    this.commitQueues.set(
      employeeId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** Runs serialized per employee; synchronous, so it is race-free. */
  private doCommit(pending: PendingBatch): CommitResult {
    const { employeeId, batchId } = pending;
    const ops = [...pending.ops.values()];
    const hash = hashOps(ops);

    const existing = this.stmtCommitByBatch.get(employeeId, batchId);
    if (existing) {
      if (existing.content_hash === hash) {
        return { ok: true, credential: String(existing.credential), commitSeq: Number(existing.id) };
      }
      return { ok: false, reason: `batch ${batchId} already committed with different content`, conflicts: [] };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conflicts: SetKey[] = [];
      for (const op of ops) {
        const current = this.currentVersion(employeeId, op.key);
        if (current !== op.baseVersion) conflicts.push(op.key);
      }
      if (conflicts.length > 0) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'stale base version', conflicts };
      }
      const credential = randomUUID();
      const { lastInsertRowid } = this.stmtInsertCommit.run(employeeId, batchId, hash, credential);
      const commitId = Number(lastInsertRowid);
      for (const op of ops) {
        if (op.kind === 'upsert') {
          this.stmtInsertHistory.run(
            commitId, employeeId, op.key.exerciseIndex, op.key.week, op.key.session, op.key.setIndex,
            op.weightLbs, op.reps, 0,
          );
        } else {
          this.stmtInsertHistory.run(
            commitId, employeeId, op.key.exerciseIndex, op.key.week, op.key.session, op.key.setIndex,
            null, null, 1,
          );
        }
      }
      this.db.exec('COMMIT');
      return { ok: true, credential, commitSeq: commitId };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private currentVersion(employeeId: string, key: SetKey): SetVersion {
    const row = this.stmtSetVersion.get(
      employeeId, key.exerciseIndex, key.week, key.session, key.setIndex,
    );
    return row && row.v !== null ? Number(row.v) : 0;
  }

  readSegmentSets(
    employeeId: string,
    commitSeq: number,
    exerciseIndex: number,
    segmentIndex: number,
  ): (VersionedSetRecord | null)[] {
    const weekLo = segmentIndex * SEGMENT_WEEKS + 1;
    const weekHi = weekLo + SEGMENT_WEEKS - 1;
    const rows = this.stmtSegment.all(employeeId, exerciseIndex, weekLo, weekHi, commitSeq);
    const slots = new Array<VersionedSetRecord | null>(SETS_PER_SEGMENT).fill(null);
    for (const row of rows) {
      const key: SetKey = {
        exerciseIndex,
        week: Number(row.week),
        session: Number(row.session),
        setIndex: Number(row.set_index),
      };
      slots[setSlot(key) - segmentIndex * SETS_PER_SEGMENT] = {
        ...key,
        weightLbs: Number(row.weight_lbs),
        reps: Number(row.reps),
        version: Number(row.commit_id),
      };
    }
    return slots;
  }

  deriveCurveAt(employeeId: string, commitSeq: number, exerciseIndex: number): number[] {
    const rows = this.stmtExercise.all(employeeId, exerciseIndex, commitSeq);
    const slots = new Array<VersionedSetRecord | null>(SETS_PER_EXERCISE).fill(null);
    for (const row of rows) {
      const key: SetKey = {
        exerciseIndex,
        week: Number(row.week),
        session: Number(row.session),
        setIndex: Number(row.set_index),
      };
      slots[setSlot(key)] = {
        ...key,
        weightLbs: Number(row.weight_lbs),
        reps: Number(row.reps),
        version: 0,
      };
    }
    return deriveExerciseCurve(slots);
  }
}

function hashOps(ops: BatchOp[]): string {
  const canonical = ops
    .map((op) => {
      const base = [
        op.kind,
        op.key.exerciseIndex,
        op.key.week,
        op.key.session,
        op.key.setIndex,
        op.baseVersion,
      ];
      if (op.kind === 'upsert') base.push(op.weightLbs, op.reps);
      return base.join(',');
    })
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

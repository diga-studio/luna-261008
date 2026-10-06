import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { deriveRecommendations } from "./curve";
import {
  CommitReceipt,
  CommitRejected,
  ExerciseSegmentView,
  MAX_EXERCISES_PER_EMPLOYEE,
  SEGMENTS_PER_CYCLE,
  SESSIONS_PER_WEEK,
  SegmentView,
  SetEntry,
  SetOperation,
  SETS_PER_SEGMENT,
  SETS_PER_SESSION,
  WEEKS_PER_CYCLE,
  WEEKS_PER_SEGMENT,
} from "./types";

/** 一个已打开、尚未提交的批次。 */
export interface BatchWriter {
  add(op: SetOperation): Promise<void>;
  commit(): Promise<CommitReceipt>;
  abort(): Promise<void>;
}

/** 一个已打开的读取视图，固定在某个已提交版本上。 */
export interface SegmentReader {
  readonly committedVersion: number;
  readSegment(segment: number): Promise<SegmentView>;
  close(): Promise<void>;
}

interface SetRow {
  exercise_id: string;
  week: number;
  session: number;
  set_no: number;
  version: number;
  weight: number | null;
  reps: number | null;
  withdrawn: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateEntry(entry: unknown): SetEntry {
  if (!isPlainObject(entry)) {
    throw new CommitRejected("INVALID_OPERATION", "entry must be an object");
  }
  const { weightLbs, reps } = entry as { weightLbs?: unknown; reps?: unknown };
  if (
    typeof weightLbs !== "number" ||
    !Number.isFinite(weightLbs) ||
    weightLbs <= 0
  ) {
    throw new CommitRejected("INVALID_OPERATION", "weightLbs must be > 0");
  }
  if (typeof reps !== "number" || !Number.isInteger(reps) || reps < 0) {
    throw new CommitRejected("INVALID_OPERATION", "reps must be an integer >= 0");
  }
  return { weightLbs, reps };
}

function canonicalHash(ops: SetOperation[]): string {
  const sorted = [...ops].sort((a, b) => {
    const ka = `${a.key.exerciseId}${a.key.week}${a.key.session}${a.key.set}${a.baseVersion}${JSON.stringify(a.entry ?? null)}`;
    const kb = `${b.key.exerciseId}${b.key.week}${b.key.session}${b.key.set}${b.baseVersion}${JSON.stringify(b.entry ?? null)}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export class TrainingStore {
  private readonly db: DatabaseSync;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  async createCycle(employeeId: string, exerciseIds: string[]): Promise<void> {
    if (!employeeId) throw new Error("employeeId is required");
    if (
      !Array.isArray(exerciseIds) ||
      exerciseIds.length === 0 ||
      exerciseIds.length > MAX_EXERCISES_PER_EMPLOYEE ||
      new Set(exerciseIds).size !== exerciseIds.length
    ) {
      throw new Error(`exerciseIds must be 1..${MAX_EXERCISES_PER_EMPLOYEE} unique ids`);
    }
    const existing = this.db
      .prepare("SELECT employee_id FROM cycles WHERE employee_id = ?")
      .get(employeeId);
    if (existing) throw new Error(`cycle already exists for ${employeeId}`);
    this.db
      .prepare(
        "INSERT INTO cycles (employee_id, exercises, created_at) VALUES (?, ?, ?)",
      )
      .run(employeeId, JSON.stringify(exerciseIds), new Date().toISOString());
  }

  private getExercises(employeeId: string): string[] {
    const row = this.db
      .prepare("SELECT exercises FROM cycles WHERE employee_id = ?")
      .get(employeeId) as { exercises: string } | undefined;
    if (!row) {
      throw new CommitRejected(
        "CYCLE_NOT_FOUND",
        `no cycle for employee ${employeeId}`,
      );
    }
    return JSON.parse(row.exercises) as string[];
  }

  private committedVersion(employeeId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM commits WHERE employee_id = ?")
      .get(employeeId) as { seq: number | null };
    return row.seq ?? 0;
  }

  private enqueue<T>(employeeId: string, task: () => T): Promise<T> {
    const prev = this.chains.get(employeeId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      employeeId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async beginBatch(employeeId: string, batchId: string): Promise<BatchWriter> {
    const exercises = new Set(this.getExercises(employeeId));
    if (!batchId) throw new Error("batchId is required");
    const ops: SetOperation[] = [];
    let closed = false;
    const store = this;

    function validateOp(op: SetOperation): void {
      if (!isPlainObject(op) || !isPlainObject(op.key)) {
        throw new CommitRejected("INVALID_OPERATION", "op.key is required");
      }
      const { key } = op;
      if (key.employeeId !== employeeId) {
        throw new CommitRejected(
          "INVALID_OPERATION",
          "op.key.employeeId must match the batch employee",
        );
      }
      if (!exercises.has(key.exerciseId)) {
        throw new CommitRejected(
          "INVALID_OPERATION",
          `unknown exercise ${key.exerciseId}`,
        );
      }
      if (
        !Number.isInteger(key.week) ||
        key.week < 1 ||
        key.week > WEEKS_PER_CYCLE ||
        !Number.isInteger(key.session) ||
        key.session < 1 ||
        key.session > SESSIONS_PER_WEEK ||
        !Number.isInteger(key.set) ||
        key.set < 1 ||
        key.set > SETS_PER_SESSION
      ) {
        throw new CommitRejected("INVALID_OPERATION", "set key out of range");
      }
      if (!Number.isInteger(op.baseVersion) || op.baseVersion < 0) {
        throw new CommitRejected(
          "INVALID_OPERATION",
          "baseVersion must be an integer >= 0",
        );
      }
      if (op.entry !== undefined) validateEntry(op.entry);
    }

    return {
      async add(op: SetOperation): Promise<void> {
        if (closed) {
          throw new CommitRejected(
            "BATCH_ALREADY_CLOSED",
            "batch is already closed",
          );
        }
        validateOp(op);
        ops.push({
          key: { ...op.key },
          baseVersion: op.baseVersion,
          ...(op.entry !== undefined ? { entry: op.entry } : {}),
        });
      },
      async commit(): Promise<CommitReceipt> {
        if (closed) {
          throw new CommitRejected(
            "BATCH_ALREADY_CLOSED",
            "batch is already closed",
          );
        }
        closed = true;
        return store.enqueue(employeeId, () =>
          store.applyBatch(employeeId, batchId, ops),
        );
      },
      async abort(): Promise<void> {
        closed = true;
        ops.length = 0;
      },
    };
  }

  private applyBatch(
    employeeId: string,
    batchId: string,
    ops: SetOperation[],
  ): CommitReceipt {
    const contentHash = canonicalHash(ops);
    const existing = this.db
      .prepare(
        "SELECT commit_id, seq, content_hash FROM commits WHERE employee_id = ? AND batch_id = ?",
      )
      .get(employeeId, batchId) as
      | { commit_id: string; seq: number; content_hash: string }
      | undefined;
    if (existing) {
      if (existing.content_hash === contentHash) {
        return {
          commitId: existing.commit_id,
          committedVersion: existing.seq,
          batchId,
        };
      }
      throw new CommitRejected(
        "BATCH_ID_CONFLICT",
        `batch ${batchId} was already committed with different content`,
      );
    }

    const seen = new Set<string>();
    for (const op of ops) {
      const id = `${op.key.exerciseId}${op.key.week}${op.key.session}${op.key.set}`;
      if (seen.has(id)) {
        throw new CommitRejected(
          "INVALID_OPERATION",
          "duplicate operation for the same set in one batch",
        );
      }
      seen.add(id);
    }

    const getCurrent = this.db.prepare(
      `SELECT version FROM current_sets
       WHERE employee_id = ? AND exercise_id = ? AND week = ? AND session = ? AND set_no = ?`,
    );
    const upsertCurrent = this.db.prepare(
      `INSERT INTO current_sets (employee_id, exercise_id, week, session, set_no, version, weight, reps, withdrawn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (employee_id, exercise_id, week, session, set_no)
       DO UPDATE SET version = excluded.version, weight = excluded.weight,
                     reps = excluded.reps, withdrawn = excluded.withdrawn`,
    );
    const insertChange = this.db.prepare(
      `INSERT INTO set_changes
       (employee_id, exercise_id, week, session, set_no, seq, version, weight, reps, withdrawn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCommit = this.db.prepare(
      `INSERT INTO commits (employee_id, seq, commit_id, batch_id, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const seq = this.committedVersion(employeeId) + 1;
    const commitId = randomUUID();
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersions = ops.map((op) => {
        const row = getCurrent.get(
          employeeId,
          op.key.exerciseId,
          op.key.week,
          op.key.session,
          op.key.set,
        ) as { version: number } | undefined;
        return row?.version ?? 0;
      });
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i] as SetOperation;
        const currentVersion = currentVersions[i] as number;
        if (currentVersion !== op.baseVersion) {
          throw new CommitRejected(
            "VERSION_CONFLICT",
            `set ${op.key.exerciseId} w${op.key.week} s${op.key.session} g${op.key.set}: ` +
              `expected version ${op.baseVersion}, current ${currentVersion}`,
          );
        }
      }
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i] as SetOperation;
        const nextVersion = (currentVersions[i] as number) + 1;
        const withdrawn = op.entry === undefined ? 1 : 0;
        const weight = op.entry?.weightLbs ?? null;
        const reps = op.entry?.reps ?? null;
        upsertCurrent.run(
          employeeId,
          op.key.exerciseId,
          op.key.week,
          op.key.session,
          op.key.set,
          nextVersion,
          weight,
          reps,
          withdrawn,
        );
        insertChange.run(
          employeeId,
          op.key.exerciseId,
          op.key.week,
          op.key.session,
          op.key.set,
          seq,
          nextVersion,
          weight,
          reps,
          withdrawn,
        );
      }
      insertCommit.run(employeeId, seq, commitId, batchId, contentHash, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { commitId, committedVersion: seq, batchId };
  }

  async openReader(employeeId: string): Promise<SegmentReader> {
    const exercises = this.getExercises(employeeId);
    const version = this.committedVersion(employeeId);
    const db = this.db;
    let cache: Map<string, SetEntry | null> | null = null;
    let closed = false;

    function loadAll(): Map<string, SetEntry | null> {
      if (cache) return cache;
      const rows = db
        .prepare(
          `SELECT exercise_id, week, session, set_no, weight, reps, withdrawn
           FROM set_changes WHERE employee_id = ? AND seq <= ? ORDER BY seq`,
        )
        .all(employeeId, version) as unknown as SetRow[];
      const map = new Map<string, SetEntry | null>();
      for (const row of rows) {
        const id = `${row.exercise_id}${row.week}${row.session}${row.set_no}`;
        map.set(
          id,
          row.withdrawn
            ? null
            : { weightLbs: row.weight as number, reps: row.reps as number },
        );
      }
      cache = map;
      return map;
    }

    return {
      committedVersion: version,
      async readSegment(segment: number): Promise<SegmentView> {
        if (closed) throw new Error("reader is closed");
        if (
          !Number.isInteger(segment) ||
          segment < 1 ||
          segment > SEGMENTS_PER_CYCLE
        ) {
          throw new Error(`segment must be 1..${SEGMENTS_PER_CYCLE}`);
        }
        const all = loadAll();
        const views: ExerciseSegmentView[] = exercises.map((exerciseId) => {
          const perSegment: Array<Array<SetEntry | null>> = [];
          for (let seg = 0; seg < SEGMENTS_PER_CYCLE; seg++) {
            const sets: Array<SetEntry | null> = [];
            for (let i = 0; i < SETS_PER_SEGMENT; i++) {
              const week = seg * WEEKS_PER_SEGMENT + Math.floor(i / 9) + 1;
              const session = Math.floor((i % 9) / 3) + 1;
              const set = (i % 3) + 1;
              sets.push(
                all.get(`${exerciseId}${week}${session}${set}`) ?? null,
              );
            }
            perSegment.push(sets);
          }
          const recommendations = deriveRecommendations(perSegment);
          return {
            exerciseId,
            recommendationLbs: recommendations[segment - 1] as number,
            sets: perSegment[segment - 1] as Array<SetEntry | null>,
          };
        });
        return { segment, committedVersion: version, exercises: views };
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
  }

  async getSetState(
    employeeId: string,
    exerciseId: string,
    week: number,
    session: number,
    set: number,
  ): Promise<{ version: number; entry: SetEntry | null }> {
    const row = this.db
      .prepare(
        `SELECT version, weight, reps, withdrawn FROM current_sets
         WHERE employee_id = ? AND exercise_id = ? AND week = ? AND session = ? AND set_no = ?`,
      )
      .get(employeeId, exerciseId, week, session, set) as
      | { version: number; weight: number | null; reps: number | null; withdrawn: number }
      | undefined;
    if (!row) return { version: 0, entry: null };
    return {
      version: row.version,
      entry: row.withdrawn
        ? null
        : { weightLbs: row.weight as number, reps: row.reps as number },
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

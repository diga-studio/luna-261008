import { DatabaseSync } from 'node:sqlite';
import { selfAndDescendants, validateGraph } from './graph.ts';
import type {
  AffectedStep,
  ChangeRequest,
  ChangeResult,
  DependencyEdge,
  ProjectDefinition,
  ProjectSnapshot,
  ReworkRequest,
  SignoffRequest,
  StepSnapshot,
  StepStatus,
  SubmitRequest,
} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS steps (
  project_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  text TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (project_id, step_id)
);
CREATE TABLE IF NOT EXISTS deps (
  project_id TEXT NOT NULL,
  pred TEXT NOT NULL,
  succ TEXT NOT NULL,
  PRIMARY KEY (project_id, pred, succ)
);
CREATE TABLE IF NOT EXISTS requests (
  project_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  content TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (project_id, request_key)
);
`;

interface StepRow {
  step_id: string;
  text: string;
  version: number;
  status: StepStatus;
}

function readStepRow(row: Record<string, unknown> | undefined): StepRow | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    step_id: String(row['step_id']),
    text: String(row['text']),
    version: Number(row['version']),
    status: String(row['status']) as StepStatus,
  };
}

/** Canonical JSON encoding of a request, used to compare replays. */
function requestContent(req: ChangeRequest): string {
  const base = {
    kind: req.kind,
    stepId: req.stepId,
    expectedVersion: req.expectedVersion,
  };
  if (req.kind === 'submit' && req.text !== undefined) {
    return JSON.stringify({ ...base, text: req.text });
  }
  return JSON.stringify(base);
}

export class AuditStore {
  readonly #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(SCHEMA);
  }

  initProject(def: ProjectDefinition): void {
    validateGraph(
      def.steps.map((s) => s.id),
      def.dependencies,
    );
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#db
        .prepare('SELECT project_id FROM projects WHERE project_id = ?')
        .get(def.projectId);
      if (existing !== undefined) {
        throw new Error(`project already exists: ${def.projectId}`);
      }
      this.#db.prepare('INSERT INTO projects (project_id) VALUES (?)').run(def.projectId);
      const insertStep = this.#db.prepare(
        'INSERT INTO steps (project_id, step_id, text, version, status) VALUES (?, ?, ?, 0, ?)',
      );
      for (const step of def.steps) {
        insertStep.run(def.projectId, step.id, step.text, 'todo');
      }
      const insertDep = this.#db.prepare('INSERT INTO deps (project_id, pred, succ) VALUES (?, ?, ?)');
      for (const edge of def.dependencies) {
        insertDep.run(def.projectId, edge.from, edge.to);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  submit(projectId: string, req: SubmitRequest): Promise<ChangeResult> {
    return Promise.resolve(this.#applyChange(projectId, req));
  }

  signoff(projectId: string, req: SignoffRequest): Promise<ChangeResult> {
    return Promise.resolve(this.#applyChange(projectId, req));
  }

  rework(projectId: string, req: ReworkRequest): Promise<ChangeResult> {
    return Promise.resolve(this.#applyChange(projectId, req));
  }

  getSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const rows = this.#db
      .prepare('SELECT step_id, text, version, status FROM steps WHERE project_id = ? ORDER BY step_id')
      .all(projectId);
    const steps: StepSnapshot[] = rows.map((row) => {
      const step = readStepRow(row)!;
      return { id: step.step_id, text: step.text, version: step.version, status: step.status };
    });
    return Promise.resolve({ projectId, steps });
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Applies one change atomically. The whole body is synchronous, so
   * concurrent calls from the same process cannot interleave; every call
   * observes and produces a complete state, equivalent to serial execution.
   */
  #applyChange(projectId: string, req: ChangeRequest): ChangeResult {
    const content = requestContent(req);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.#db
        .prepare('SELECT content, result FROM requests WHERE project_id = ? AND request_key = ?')
        .get(projectId, req.requestKey);
      if (replay !== undefined) {
        this.#db.exec('COMMIT');
        if (String(replay['content']) === content) {
          return JSON.parse(String(replay['result'])) as ChangeResult;
        }
        return { type: 'request_key_conflict', requestKey: req.requestKey };
      }

      const step = readStepRow(
        this.#db
          .prepare('SELECT step_id, text, version, status FROM steps WHERE project_id = ? AND step_id = ?')
          .get(projectId, req.stepId),
      );
      if (step === undefined) {
        this.#db.exec('ROLLBACK');
        return { type: 'precondition_failed', reason: `unknown step: ${req.stepId}` };
      }
      if (step.version !== req.expectedVersion) {
        this.#db.exec('ROLLBACK');
        return { type: 'version_conflict', stepId: req.stepId, currentVersion: step.version };
      }

      let affected: AffectedStep[];
      if (req.kind === 'rework') {
        affected = this.#applyRework(projectId, req.stepId);
      } else {
        const check = this.#checkTransitionPreconditions(projectId, step, req.kind);
        if (check !== undefined) {
          this.#db.exec('ROLLBACK');
          return check;
        }
        affected = [this.#applyTransition(projectId, step, req)];
      }

      const result: ChangeResult = { type: 'ok', kind: req.kind, affected };
      this.#db
        .prepare('INSERT INTO requests (project_id, request_key, content, result) VALUES (?, ?, ?, ?)')
        .run(projectId, req.requestKey, content, JSON.stringify(result));
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #checkTransitionPreconditions(
    projectId: string,
    step: StepRow,
    kind: 'submit' | 'signoff',
  ): ChangeResult | undefined {
    const requiredStatus: StepStatus = kind === 'submit' ? 'todo' : 'in_review';
    if (step.status !== requiredStatus) {
      return {
        type: 'precondition_failed',
        reason: `step ${step.step_id} is ${step.status}, expected ${requiredStatus}`,
      };
    }
    const incomplete = this.#db
      .prepare(
        `SELECT d.pred AS pred, s.status AS status
         FROM deps d JOIN steps s ON s.project_id = d.project_id AND s.step_id = d.pred
         WHERE d.project_id = ? AND d.succ = ? AND s.status <> 'completed'
         ORDER BY d.pred`,
      )
      .all(projectId, step.step_id);
    if (incomplete.length > 0) {
      const pred = String(incomplete[0]!['pred']);
      return {
        type: 'precondition_failed',
        reason: `predecessor ${pred} is not completed`,
      };
    }
    return undefined;
  }

  #applyTransition(projectId: string, step: StepRow, req: SubmitRequest | SignoffRequest): AffectedStep {
    const nextVersion = step.version + 1;
    if (req.kind === 'submit') {
      const nextStatus: StepStatus = 'in_review';
      if (req.text !== undefined) {
        this.#db
          .prepare('UPDATE steps SET status = ?, version = ?, text = ? WHERE project_id = ? AND step_id = ?')
          .run(nextStatus, nextVersion, req.text, projectId, step.step_id);
      } else {
        this.#db
          .prepare('UPDATE steps SET status = ?, version = ? WHERE project_id = ? AND step_id = ?')
          .run(nextStatus, nextVersion, projectId, step.step_id);
      }
      return { stepId: step.step_id, version: nextVersion, status: nextStatus };
    }
    const nextStatus: StepStatus = 'completed';
    this.#db
      .prepare('UPDATE steps SET status = ?, version = ? WHERE project_id = ? AND step_id = ?')
      .run(nextStatus, nextVersion, projectId, step.step_id);
    return { stepId: step.step_id, version: nextVersion, status: nextStatus };
  }

  #applyRework(projectId: string, stepId: string): AffectedStep[] {
    const edgeRows = this.#db
      .prepare('SELECT pred, succ FROM deps WHERE project_id = ?')
      .all(projectId);
    const edges: DependencyEdge[] = edgeRows.map((row) => ({
      from: String(row['pred']),
      to: String(row['succ']),
    }));
    const targets = selfAndDescendants(edges, stepId);
    const update = this.#db.prepare(
      `UPDATE steps SET status = 'todo', version = version + 1 WHERE project_id = ? AND step_id = ?`,
    );
    const affected: AffectedStep[] = [];
    for (const id of targets) {
      update.run(projectId, id);
      const row = readStepRow(
        this.#db
          .prepare('SELECT step_id, text, version, status FROM steps WHERE project_id = ? AND step_id = ?')
          .get(projectId, id),
      )!;
      affected.push({ stepId: id, version: row.version, status: row.status });
    }
    return affected;
  }
}

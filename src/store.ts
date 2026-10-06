import { DatabaseSync } from 'node:sqlite';
import type { ProjectSpec, StepSnapshot, StepStatus } from './types.js';
import { DependencyGraph } from './graph.js';

export interface StoredRequest {
  fingerprint: string;
  resultJson: string;
}

interface StepRow {
  step_id: string;
  text: string;
  version: number | bigint;
  status: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS steps (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        step_id TEXT NOT NULL,
        text TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (project_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS edges (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        from_step TEXT NOT NULL,
        to_step TEXT NOT NULL,
        PRIMARY KEY (project_id, from_step, to_step)
      );
      CREATE TABLE IF NOT EXISTS requests (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (project_id, request_key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  projectExists(projectId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS one FROM projects WHERE project_id = ?')
      .get(projectId);
    return row !== undefined;
  }

  createProject(spec: ProjectSpec): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO projects (project_id) VALUES (?)')
        .run(spec.projectId);
      const insertStep = this.db.prepare(
        'INSERT INTO steps (project_id, step_id, text, version, status) VALUES (?, ?, ?, 0, ?)',
      );
      for (const step of spec.steps) {
        insertStep.run(spec.projectId, step.id, step.text ?? '', 'todo');
      }
      const insertEdge = this.db.prepare(
        'INSERT OR IGNORE INTO edges (project_id, from_step, to_step) VALUES (?, ?, ?)',
      );
      for (const [from, to] of spec.edges) {
        insertEdge.run(spec.projectId, from, to);
      }
    });
  }

  loadGraph(projectId: string): DependencyGraph {
    const stepRows = this.db
      .prepare('SELECT step_id FROM steps WHERE project_id = ?')
      .all(projectId) as unknown as Array<{ step_id: string }>;
    const edgeRows = this.db
      .prepare('SELECT from_step, to_step FROM edges WHERE project_id = ?')
      .all(projectId) as unknown as Array<{ from_step: string; to_step: string }>;
    return DependencyGraph.create(
      stepRows.map((r) => r.step_id),
      edgeRows.map((r) => [r.from_step, r.to_step] as const),
    );
  }

  getStep(projectId: string, stepId: string): StepSnapshot | undefined {
    const row = this.db
      .prepare(
        'SELECT step_id, text, version, status FROM steps WHERE project_id = ? AND step_id = ?',
      )
      .get(projectId, stepId) as unknown as StepRow | undefined;
    return row ? toSnapshot(row) : undefined;
  }

  listSteps(projectId: string): StepSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT step_id, text, version, status FROM steps WHERE project_id = ? ORDER BY step_id',
      )
      .all(projectId) as unknown as StepRow[];
    return rows.map(toSnapshot);
  }

  applyStepUpdates(projectId: string, updates: StepSnapshot[]): void {
    const update = this.db.prepare(
      'UPDATE steps SET text = ?, version = ?, status = ? WHERE project_id = ? AND step_id = ?',
    );
    for (const step of updates) {
      update.run(step.text, step.version, step.status, projectId, step.id);
    }
  }

  findRequest(projectId: string, requestKey: string): StoredRequest | undefined {
    const row = this.db
      .prepare(
        'SELECT fingerprint, result_json FROM requests WHERE project_id = ? AND request_key = ?',
      )
      .get(projectId, requestKey) as unknown as
      | { fingerprint: string; result_json: string }
      | undefined;
    return row ? { fingerprint: row.fingerprint, resultJson: row.result_json } : undefined;
  }

  saveRequest(
    projectId: string,
    requestKey: string,
    fingerprint: string,
    resultJson: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO requests (project_id, request_key, fingerprint, result_json) VALUES (?, ?, ?, ?)',
      )
      .run(projectId, requestKey, fingerprint, resultJson);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toSnapshot(row: StepRow): StepSnapshot {
  return {
    id: row.step_id,
    text: row.text,
    version: Number(row.version),
    status: row.status as StepStatus,
  };
}

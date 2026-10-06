import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { computeReleaseFacts, evaluateGate, relevantFingerprint, toBasis } from './gate.js';
import type {
  BatchUpdate,
  ConfirmResult,
  ConfirmToken,
  GateBasis,
  GatePreview,
  ReleaseInfo,
} from './types.js';

export interface ShipCycleOptions {
  /** SQLite 文件路径；':memory:' 表示纯内存 */
  path: string;
}

/**
 * 所有公开方法内部均为同步执行（node:sqlite 为同步驱动），
 * 单次调用在事件循环中不可中断，因此并发调用天然按完整顺序串行生效。
 */
export class ShipCycle {
  private readonly db: DatabaseSync;

  constructor(options: ShipCycleOptions) {
    this.db = openDatabase(options.path);
  }

  /** 初始化发布：至少一个组件 + 至少一个 GTM 清单项，初始为 Planning。 */
  async initRelease(input: {
    releaseId: string;
    components: string[];
    checklistItems: string[];
  }): Promise<ReleaseInfo> {
    const { releaseId, components, checklistItems } = input;
    if (!releaseId) throw new Error('releaseId is required');
    if (components.length === 0) throw new Error('at least one component is required');
    if (checklistItems.length === 0) throw new Error('at least one checklist item is required');
    if (new Set(components).size !== components.length) throw new Error('duplicate components');
    if (new Set(checklistItems).size !== checklistItems.length) {
      throw new Error('duplicate checklist items');
    }
    const existing = this.db
      .prepare('SELECT release_id FROM releases WHERE release_id = ?')
      .get(releaseId);
    if (existing) throw new Error(`release already exists: ${releaseId}`);

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare("INSERT INTO releases (release_id, status, gate_version, created_at) VALUES (?, 'Planning', 0, ?)")
        .run(releaseId, Date.now());
      const componentStmt = this.db.prepare(
        'INSERT INTO release_components (release_id, component_id) VALUES (?, ?)',
      );
      for (const componentId of components) componentStmt.run(releaseId, componentId);
      const checklistStmt = this.db.prepare(
        'INSERT INTO release_checklist (release_id, item, done) VALUES (?, ?, 0)',
      );
      for (const item of checklistItems) checklistStmt.run(releaseId, item);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getRelease(releaseId);
  }

  /** 批量更新门禁事实，整个批次在单个事务中作为一次变化生效。 */
  async applyBatch(releaseId: string, batch: BatchUpdate): Promise<void> {
    const release = this.mustGetReleaseRow(releaseId);
    if (release.status !== 'Planning') throw new Error(`release ${releaseId} is not Planning`);

    const componentIds = this.componentIdsOf(releaseId);
    const componentSet = new Set(componentIds);

    for (const t of batch.tests ?? []) {
      if (!componentSet.has(t.componentId)) {
        throw new Error(`component ${t.componentId} is not part of release ${releaseId}`);
      }
    }
    for (const e of batch.expectedStates ?? []) {
      if (!componentSet.has(e.componentId)) {
        throw new Error(`component ${e.componentId} is not part of release ${releaseId}`);
      }
    }
    const checklistItems = new Set(
      (this.db.prepare('SELECT item FROM release_checklist WHERE release_id = ?').all(releaseId) as {
        item: string;
      }[]).map((r) => r.item),
    );
    for (const c of batch.checklist ?? []) {
      if (!checklistItems.has(c.item)) {
        throw new Error(`checklist item ${c.item} does not exist on release ${releaseId}`);
      }
    }

    // Bug 属于组件并在发布间共享：Bug 变更可能影响其他发布的 P0 阻塞集合。
    const touchedComponents = new Set<string>();
    for (const b of batch.bugs ?? []) {
      touchedComponents.add(b.componentId);
      const existing = this.db
        .prepare('SELECT component_id FROM bugs WHERE bug_id = ?')
        .get(b.bugId) as { component_id: string } | undefined;
      if (existing) touchedComponents.add(existing.component_id);
    }
    const affectedReleaseIds = new Set<string>([releaseId]);
    if (touchedComponents.size > 0) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT release_id, component_id FROM release_components
           WHERE component_id IN (${[...touchedComponents].map(() => '?').join(',')})`,
        )
        .all(...touchedComponents) as { release_id: string }[];
      for (const row of rows) affectedReleaseIds.add(row.release_id);
    }

    const fingerprintsBefore = new Map<string, string>();
    for (const id of affectedReleaseIds) {
      fingerprintsBefore.set(id, relevantFingerprint(computeReleaseFacts(this.db, id)));
    }

    this.db.exec('BEGIN');
    try {
      for (const b of batch.bugs ?? []) {
        this.db
          .prepare(
            `INSERT INTO bugs (bug_id, component_id, severity, status)
             VALUES (?, ?, COALESCE(?, 'P1'), COALESCE(?, 'Open'))
             ON CONFLICT (bug_id) DO UPDATE SET
               severity = COALESCE(excluded.severity, bugs.severity),
               status = COALESCE(excluded.status, bugs.status)`,
          )
          .run(b.bugId, b.componentId, b.severity ?? null, b.status ?? null);
      }
      const testStmt = this.db.prepare(
        `INSERT INTO tests (release_id, component_id, test_id, completed_at, passed, total, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of batch.tests ?? []) {
        const completedAt = typeof t.completedAt === 'number' ? t.completedAt : Date.parse(t.completedAt);
        if (!Number.isFinite(completedAt)) throw new Error(`invalid completedAt: ${t.completedAt}`);
        testStmt.run(releaseId, t.componentId, t.testId, completedAt, t.passed, t.total, t.skipped);
      }
      const expectedStmt = this.db.prepare(
        `INSERT INTO expected_states (release_id, component_id, state) VALUES (?, ?, ?)
         ON CONFLICT (release_id, component_id) DO UPDATE SET state = excluded.state`,
      );
      for (const e of batch.expectedStates ?? []) expectedStmt.run(releaseId, e.componentId, e.state);
      const checklistStmt = this.db.prepare(
        'UPDATE release_checklist SET done = ? WHERE release_id = ? AND item = ?',
      );
      for (const c of batch.checklist ?? []) checklistStmt.run(c.done ? 1 : 0, releaseId, c.item);

      // 相关事实发生变化的发布：递增门禁版本，使此前签发的凭据失效（改回原值同样失效）。
      for (const id of affectedReleaseIds) {
        const after = relevantFingerprint(computeReleaseFacts(this.db, id));
        if (after !== fingerprintsBefore.get(id)) {
          this.db.prepare('UPDATE releases SET gate_version = gate_version + 1 WHERE release_id = ?').run(id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 查看门禁：返回可发布性、阻塞原因、对应依据与确认凭据。 */
  async previewGate(releaseId: string): Promise<GatePreview> {
    const release = this.mustGetReleaseRow(releaseId);

    if (release.status === 'Released') {
      const record = this.db
        .prepare('SELECT basis_json FROM release_records WHERE release_id = ?')
        .get(releaseId) as { basis_json: string };
      return {
        releaseId,
        status: 'Released',
        releasable: false,
        blockingReasons: [],
        basis: JSON.parse(record.basis_json) as GateBasis,
        token: null,
      };
    }

    const facts = computeReleaseFacts(this.db, releaseId);
    const { releasable, blockingReasons } = evaluateGate(facts);
    const token: ConfirmToken = {
      releaseId,
      gateVersion: release.gate_version,
      nonce: randomUUID(),
    };
    return {
      releaseId,
      status: 'Planning',
      releasable,
      blockingReasons,
      basis: toBasis(releaseId, facts),
      token,
    };
  }

  /** 携带有效凭据确认发布；凭据失效或门禁不满足时拒绝，且不留下任何成功记录。 */
  async confirmRelease(releaseId: string, token: ConfirmToken): Promise<ConfirmResult> {
    const release = this.mustGetReleaseRow(releaseId);

    if (release.status === 'Released') {
      return { ok: false, releaseId, status: 'Released', record: null, error: 'release already confirmed' };
    }
    if (!token || token.releaseId !== releaseId || token.gateVersion !== release.gate_version) {
      return { ok: false, releaseId, status: 'Planning', record: null, error: 'stale or invalid confirm token' };
    }

    const facts = computeReleaseFacts(this.db, releaseId);
    const { releasable, blockingReasons } = evaluateGate(facts);
    if (!releasable) {
      return {
        ok: false,
        releaseId,
        status: 'Planning',
        record: null,
        error: `gate not satisfied: ${blockingReasons.join('; ')}`,
      };
    }

    const basis = toBasis(releaseId, facts);
    const confirmedAt = Date.now();
    this.db.exec('BEGIN');
    try {
      // 同步事务内再次校验，确认与写入构成同一次完整判断。
      const current = this.db
        .prepare('SELECT status, gate_version FROM releases WHERE release_id = ?')
        .get(releaseId) as { status: string; gate_version: number };
      if (current.status !== 'Planning' || current.gate_version !== token.gateVersion) {
        this.db.exec('ROLLBACK');
        return { ok: false, releaseId, status: 'Planning', record: null, error: 'stale or invalid confirm token' };
      }
      this.db.prepare("UPDATE releases SET status = 'Released' WHERE release_id = ?").run(releaseId);
      this.db
        .prepare('INSERT INTO release_records (release_id, confirmed_at, basis_json) VALUES (?, ?, ?)')
        .run(releaseId, confirmedAt, JSON.stringify(basis));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      ok: true,
      releaseId,
      status: 'Released',
      record: { ...basis, confirmedAt },
    };
  }

  async getRelease(releaseId: string): Promise<ReleaseInfo> {
    const release = this.mustGetReleaseRow(releaseId);
    return {
      releaseId,
      status: release.status as ReleaseInfo['status'],
      components: this.componentIdsOf(releaseId),
      checklist: (
        this.db.prepare('SELECT item, done FROM release_checklist WHERE release_id = ? ORDER BY item').all(releaseId) as {
          item: string;
          done: number;
        }[]
      ).map((r) => ({ item: r.item, done: r.done !== 0 })),
      gateVersion: release.gate_version,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private mustGetReleaseRow(releaseId: string): { status: string; gate_version: number } {
    const row = this.db
      .prepare('SELECT status, gate_version FROM releases WHERE release_id = ?')
      .get(releaseId) as { status: string; gate_version: number } | undefined;
    if (!row) throw new Error(`release not found: ${releaseId}`);
    return row;
  }

  private componentIdsOf(releaseId: string): string[] {
    return (
      this.db
        .prepare('SELECT component_id FROM release_components WHERE release_id = ? ORDER BY component_id')
        .all(releaseId) as { component_id: string }[]
    ).map((r) => r.component_id);
  }
}

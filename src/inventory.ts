import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.js';
import type {
  Adjustment,
  AdjustmentItem,
  ApprovalResult,
  Conflict,
  Device,
  DeviceDiff,
  DiffKind,
  Field,
  Mark,
  ScanEntry,
  TaskResult,
  TaskStatus,
} from './types.js';

interface DeviceRow {
  tag: string;
  area: string;
  custodian: string;
  mark: string;
}

interface TaskRow {
  id: number;
  status: string;
  submitted: number;
  baseline_seq: number;
  adjustment_id: number | null;
}

/** 审批时单个字段的修改提议 */
interface Proposal {
  tag: string;
  field: Field;
  baselineValue: string;
  targetValue: string;
  /** 短缺项：位置/保管人曾实际变化则优先判冲突 */
  guardMissingMoved: boolean;
}

const FIELDS: Field[] = ['area', 'custodian', 'mark'];

/** 工业设备盘点对账库主入口 */
export class InventoryLedger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 载入初始账册（仅允许在空账册上调用一次） */
  initLedger(devices: Device[]): void {
    this.db.exec('BEGIN');
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number };
      if (count.n > 0) throw new Error('账册已初始化，不能重复载入');
      const insert = this.db.prepare(
        'INSERT INTO devices (tag, area, custodian, mark) VALUES (?, ?, ?, ?)',
      );
      for (const d of devices) {
        assertMark(d.mark);
        insert.run(d.tag, d.area, d.custodian, d.mark);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 开启盘点任务：冻结当前整份账册为基线，返回任务 id */
  openTask(scope: string[]): number {
    if (scope.length === 0) throw new Error('盘点范围不能为空');
    this.db.exec('BEGIN');
    try {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events')
        .get() as { s: number };
      const task = this.db
        .prepare('INSERT INTO tasks (status, baseline_seq) VALUES (\'open\', ?)')
        .run(seqRow.s);
      const taskId = Number(task.lastInsertRowid);
      const insertScope = this.db.prepare('INSERT INTO task_scope (task_id, area) VALUES (?, ?)');
      for (const area of new Set(scope)) insertScope.run(taskId, area);
      this.db
        .prepare(
          'INSERT INTO baselines (task_id, tag, area, custodian, mark) SELECT ?, tag, area, custodian, mark FROM devices',
        )
        .run(taskId);
      this.db.exec('COMMIT');
      return taskId;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 提交整份盘点结果，提交后固定不可改 */
  submitResult(taskId: number, entries: ScanEntry[]): void {
    const task = this.requireTask(taskId);
    if (task.status !== 'open') throw new Error(`任务 ${taskId} 已审批，不能提交`);
    if (task.submitted) throw new Error(`任务 ${taskId} 已提交过结果，不能修改`);
    const scope = this.loadScope(taskId);
    const findDevice = this.db.prepare('SELECT tag FROM devices WHERE tag = ?');
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        'INSERT INTO submissions (task_id, tag, area, custodian) VALUES (?, ?, ?, ?)',
      );
      for (const e of entries) {
        if (!findDevice.get(e.tag)) throw new Error(`标签 ${e.tag} 未登记`);
        if (!scope.has(e.area)) throw new Error(`实测区域 ${e.area} 不在任务 ${taskId} 范围内`);
        insert.run(taskId, e.tag, e.area, e.custodian);
      }
      this.db.prepare('UPDATE tasks SET submitted = 1 WHERE id = ?').run(taskId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 查看任务结果（含按冻结基线判定的差异清单） */
  getTaskResult(taskId: number): TaskResult {
    const task = this.requireTask(taskId);
    return {
      taskId,
      status: task.status as TaskStatus,
      scope: [...this.loadScope(taskId)].sort(),
      submitted: this.isSubmitted(taskId),
      adjustmentId: task.adjustment_id,
      diffs: this.isSubmitted(taskId) ? this.computeDiffs(taskId) : [],
    };
  }

  /** 审批对账：全部通过才落账并生成唯一调整单 */
  approve(taskId: number): ApprovalResult {
    const task = this.requireTask(taskId);
    if (task.status === 'approved') {
      return { ok: true, adjustment: this.getAdjustment(task.adjustment_id!) };
    }
    if (!this.isSubmitted(taskId)) throw new Error(`任务 ${taskId} 尚未提交盘点结果`);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposals = this.buildProposals(taskId);
      const conflicts: Conflict[] = [];
      const changes: Array<{ tag: string; field: Field; oldValue: string; newValue: string }> = [];

      for (const p of proposals) {
        if (p.guardMissingMoved && this.hasMovedSince(p.tag, task.baseline_seq)) {
          conflicts.push({
            tag: p.tag,
            field: null,
            reason: 'missing-device-moved',
            baselineValue: null,
            currentValue: null,
            targetValue: null,
          });
          continue;
        }
        const row = this.db
          .prepare(`SELECT ${p.field} AS v FROM devices WHERE tag = ?`)
          .get(p.tag) as { v: string };
        const current = row.v;
        if (current === p.baselineValue) {
          changes.push({ tag: p.tag, field: p.field, oldValue: current, newValue: p.targetValue });
        } else if (current === p.targetValue) {
          // 已收敛，不重复修改
        } else {
          conflicts.push({
            tag: p.tag,
            field: p.field,
            reason: 'field-conflict',
            baselineValue: p.baselineValue,
            currentValue: current,
            targetValue: p.targetValue,
          });
        }
      }

      if (conflicts.length > 0) {
        this.db.exec('ROLLBACK');
        return { ok: false, conflicts };
      }

      const adj = this.db.prepare('INSERT INTO adjustments (task_id) VALUES (?)').run(taskId);
      const adjustmentId = Number(adj.lastInsertRowid);
      const updateDevice = this.db.prepare('UPDATE devices SET area = ?, custodian = ?, mark = ? WHERE tag = ?');
      const insertItem = this.db.prepare(
        'INSERT INTO adjustment_items (adjustment_id, tag, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
      );
      const insertEvent = this.db.prepare(
        'INSERT INTO events (tag, field, old_value, new_value, source, source_id) VALUES (?, ?, ?, ?, \'approval\', ?)',
      );
      const touched = new Map<string, Device>();
      for (const c of changes) {
        insertItem.run(adjustmentId, c.tag, c.field, c.oldValue, c.newValue);
        insertEvent.run(c.tag, c.field, c.oldValue, c.newValue, adjustmentId);
        const dev =
          touched.get(c.tag) ??
          (this.db.prepare('SELECT tag, area, custodian, mark FROM devices WHERE tag = ?').get(c.tag) as unknown as Device);
        (dev[c.field] as string) = c.newValue;
        touched.set(c.tag, dev);
      }
      for (const dev of touched.values()) {
        updateDevice.run(dev.area, dev.custodian, dev.mark, dev.tag);
      }
      this.db
        .prepare('UPDATE tasks SET status = \'approved\', adjustment_id = ? WHERE id = ?')
        .run(adjustmentId, taskId);
      this.db.exec('COMMIT');
      return { ok: true, adjustment: this.getAdjustment(adjustmentId) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 登记日常调拨（可同时改变位置与保管人，盘点标记不变） */
  transfer(tag: string, area: string, custodian: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT tag, area, custodian, mark FROM devices WHERE tag = ?')
        .get(tag) as DeviceRow | undefined;
      if (!row) throw new Error(`标签 ${tag} 未登记`);
      const insertEvent = this.db.prepare(
        'INSERT INTO events (tag, field, old_value, new_value, source, source_id) VALUES (?, ?, ?, ?, \'transfer\', NULL)',
      );
      if (row.area !== area) insertEvent.run(tag, 'area', row.area, area);
      if (row.custodian !== custodian) insertEvent.run(tag, 'custodian', row.custodian, custodian);
      if (row.area !== area || row.custodian !== custodian) {
        this.db.prepare('UPDATE devices SET area = ?, custodian = ? WHERE tag = ?').run(area, custodian, tag);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 查看当前账册 */
  getLedger(): Device[] {
    const rows = this.db
      .prepare('SELECT tag, area, custodian, mark FROM devices ORDER BY tag')
      .all() as unknown as DeviceRow[];
    return rows.map((r) => ({ tag: r.tag, area: r.area, custodian: r.custodian, mark: r.mark as Mark }));
  }

  /** 查看调整单 */
  getAdjustment(id: number): Adjustment {
    const adj = this.db
      .prepare('SELECT id, task_id FROM adjustments WHERE id = ?')
      .get(id) as { id: number; task_id: number } | undefined;
    if (!adj) throw new Error(`调整单 ${id} 不存在`);
    const items = this.db
      .prepare(
        'SELECT tag, field, old_value, new_value FROM adjustment_items WHERE adjustment_id = ? ORDER BY tag, field',
      )
      .all(id) as unknown as Array<{ tag: string; field: Field; old_value: string; new_value: string }>;
    return {
      id: adj.id,
      taskId: adj.task_id,
      items: items.map<AdjustmentItem>((i) => ({
        tag: i.tag,
        field: i.field,
        oldValue: i.old_value,
        newValue: i.new_value,
      })),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- 内部 helpers ----

  private requireTask(taskId: number): TaskRow {
    const task = this.db
      .prepare('SELECT id, status, submitted, baseline_seq, adjustment_id FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`任务 ${taskId} 不存在`);
    return task;
  }

  private loadScope(taskId: number): Set<string> {
    const rows = this.db.prepare('SELECT area FROM task_scope WHERE task_id = ?').all(taskId) as unknown as Array<{ area: string }>;
    return new Set(rows.map((r) => r.area));
  }

  private isSubmitted(taskId: number): boolean {
    return this.requireTask(taskId).submitted === 1;
  }

  /** 差异判定：只看冻结基线与提交结果，不看当前账册 */
  private computeDiffs(taskId: number): DeviceDiff[] {
    const scope = this.loadScope(taskId);
    const baselines = this.db
      .prepare('SELECT tag, area, custodian, mark FROM baselines WHERE task_id = ?')
      .all(taskId) as unknown as DeviceRow[];
    const submissions = new Map<string, ScanEntry>(
      (
        this.db
          .prepare('SELECT tag, area, custodian FROM submissions WHERE task_id = ?')
          .all(taskId) as unknown as ScanEntry[]
      ).map((s) => [s.tag, { tag: s.tag, area: s.area, custodian: s.custodian }]),
    );
    const diffs: DeviceDiff[] = [];
    for (const b of baselines) {
      const scanned = submissions.get(b.tag) ?? null;
      const baseline: Device = { tag: b.tag, area: b.area, custodian: b.custodian, mark: b.mark as Mark };
      if (!scanned) {
        if (scope.has(b.area)) diffs.push({ tag: b.tag, kinds: ['missing'], baseline, scanned: null });
        continue;
      }
      const kinds: DiffKind[] = [];
      if (!scope.has(b.area)) {
        kinds.push('surplus');
      } else {
        if (scanned.area !== b.area) kinds.push('location');
        if (scanned.custodian !== b.custodian) kinds.push('custodian');
      }
      if (kinds.length > 0) diffs.push({ tag: b.tag, kinds, baseline, scanned });
    }
    diffs.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    return diffs;
  }

  /** 由提交结果与冻结基线生成字段级修改提议（只有目标与基线不同的字段参与） */
  private buildProposals(taskId: number): Proposal[] {
    const scope = this.loadScope(taskId);
    const baselines = new Map<string, Device>(
      (
        this.db
          .prepare('SELECT tag, area, custodian, mark FROM baselines WHERE task_id = ?')
          .all(taskId) as unknown as DeviceRow[]
      ).map((b) => [b.tag, { tag: b.tag, area: b.area, custodian: b.custodian, mark: b.mark as Mark }]),
    );
    const submissions = this.db
      .prepare('SELECT tag, area, custodian FROM submissions WHERE task_id = ?')
      .all(taskId) as unknown as ScanEntry[];
    const scannedTags = new Set(submissions.map((s) => s.tag));
    const proposals: Proposal[] = [];
    // 扫描设备：目标为实测位置、实测保管人和“已找到”
    for (const s of submissions) {
      const baseline = baselines.get(s.tag)!;
      const targets: Record<Field, string> = { area: s.area, custodian: s.custodian, mark: 'found' };
      for (const field of FIELDS) {
        if (targets[field] !== baseline[field]) {
          proposals.push({
            tag: s.tag,
            field,
            baselineValue: baseline[field],
            targetValue: targets[field],
            guardMissingMoved: false,
          });
        }
      }
    }
    // 短缺设备：只提出把盘点标记改为“待查”
    for (const baseline of baselines.values()) {
      if (scannedTags.has(baseline.tag) || !scope.has(baseline.area)) continue;
      if (baseline.mark !== 'pending') {
        proposals.push({
          tag: baseline.tag,
          field: 'mark',
          baselineValue: baseline.mark,
          targetValue: 'pending',
          guardMissingMoved: true,
        });
      }
    }
    return proposals;
  }

  /** 任务开启后，设备的位置或保管人是否曾发生实际变化 */
  private hasMovedSince(tag: string, baselineSeq: number): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE tag = ? AND seq > ? AND field IN ('area','custodian')",
      )
      .get(tag, baselineSeq) as { n: number };
    return row.n > 0;
  }
}

function assertMark(mark: string): asserts mark is Mark {
  if (mark !== 'found' && mark !== 'pending') throw new Error(`非法盘点标记: ${mark}`);
}

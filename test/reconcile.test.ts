import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryLedger } from '../src/index.js';
import type {
  Device,
  DeviceDiff,
  DiffKind,
  Field,
  Mark,
  ScanEntry,
} from '../src/index.js';

// ---------- 独立预期模型：只依据冻结基线与操作记录计算，不经过被测库 ----------

interface ModelEvent {
  tag: string;
  field: Field;
}

/** 独立维护的账册模型与字段级变更流水 */
class Model {
  devices = new Map<string, Device>();
  events: ModelEvent[] = [];
  private seq = 0;

  load(devices: Device[]): void {
    for (const d of devices) this.devices.set(d.tag, { ...d });
  }

  snapshot(): Map<string, Device> {
    return new Map([...this.devices].map(([t, d]) => [t, { ...d }]));
  }

  now(): number {
    return this.seq;
  }

  transfer(tag: string, area: string, custodian: string): void {
    const d = this.devices.get(tag)!;
    if (d.area !== area) {
      d.area = area;
      this.events.push({ tag, field: 'area' });
      this.seq++;
    }
    if (d.custodian !== custodian) {
      d.custodian = custodian;
      this.events.push({ tag, field: 'custodian' });
      this.seq++;
    }
  }

  /** 按业务规则独立计算差异清单 */
  diffs(baseline: Map<string, Device>, scope: string[], entries: ScanEntry[]): DeviceDiff[] {
    const scopeSet = new Set(scope);
    const scanned = new Map(entries.map((e) => [e.tag, e]));
    const out: DeviceDiff[] = [];
    for (const b of baseline.values()) {
      const s = scanned.get(b.tag) ?? null;
      if (!s) {
        if (scopeSet.has(b.area)) out.push({ tag: b.tag, kinds: ['missing'], baseline: b, scanned: null });
        continue;
      }
      const kinds: DiffKind[] = [];
      if (!scopeSet.has(b.area)) {
        kinds.push('surplus');
      } else {
        if (s.area !== b.area) kinds.push('location');
        if (s.custodian !== b.custodian) kinds.push('custodian');
      }
      if (kinds.length > 0) out.push({ tag: b.tag, kinds, baseline: b, scanned: s });
    }
    out.sort((a, b) => (a.tag < b.tag ? -1 : 1));
    return out;
  }

  /**
   * 按业务规则独立模拟审批：返回实际改变的字段清单，或冲突清单。
   * 成功时同步推进模型账册与变更流水。
   */
  approve(
    baseline: Map<string, Device>,
    baselineSeq: number,
    scope: string[],
    entries: ScanEntry[],
  ): { ok: true; changes: Array<{ tag: string; field: Field; oldValue: string; newValue: string }> } | { ok: false } {
    const changes: Array<{ tag: string; field: Field; oldValue: string; newValue: string }> = [];
    const scopeSet = new Set(scope);
    const scannedTags = new Set(entries.map((e) => e.tag));
    const proposals: Array<{ tag: string; field: Field; target: string; guard: boolean }> = [];
    for (const e of entries) {
      const b = baseline.get(e.tag)!;
      const targets: Record<Field, string> = { area: e.area, custodian: e.custodian, mark: 'found' };
      for (const field of ['area', 'custodian', 'mark'] as Field[]) {
        if (targets[field] !== b[field]) proposals.push({ tag: e.tag, field, target: targets[field], guard: false });
      }
    }
    for (const b of baseline.values()) {
      if (scannedTags.has(b.tag) || !scopeSet.has(b.area)) continue;
      if (b.mark !== 'pending') proposals.push({ tag: b.tag, field: 'mark', target: 'pending', guard: true });
    }
    for (const p of proposals) {
      if (p.guard) {
        const moved = this.events.some(
          (e, i) => e.tag === p.tag && i >= baselineSeq && (e.field === 'area' || e.field === 'custodian'),
        );
        if (moved) return { ok: false };
      }
      const current = this.devices.get(p.tag)![p.field];
      if (current === baseline.get(p.tag)![p.field]) {
        changes.push({ tag: p.tag, field: p.field, oldValue: current, newValue: p.target });
      } else if (current === p.target) {
        // 已收敛
      } else {
        return { ok: false };
      }
    }
    for (const c of changes) {
      const d = this.devices.get(c.tag)!;
      (d[c.field] as string) = c.newValue;
      this.events.push({ tag: c.tag, field: c.field });
      this.seq++;
    }
    return { ok: true, changes };
  }

  ledger(): Device[] {
    return [...this.devices.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1));
  }
}

// ---------- 测试工具 ----------

function makeDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'inv-test-'));
  return { path: join(dir, 'test.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sortedItems(items: Array<{ tag: string; field: string }>) {
  return [...items].sort((a, b) => (a.tag + a.field < b.tag + b.field ? -1 : 1));
}

// ---------- 场景 1：重叠任务的兼容合并、相同目标收敛、含冲突批次整单拒绝 ----------

test('重叠任务并发审批：兼容变更正确合并，相同目标收敛，冲突批次整单不落账', () => {
  const { path, cleanup } = makeDb();
  try {
    const initial: Device[] = [
      { tag: 'D1', area: 'East', custodian: 'Alice', mark: 'pending' },
      { tag: 'D2', area: 'East', custodian: 'Bob', mark: 'pending' },
      { tag: 'D3', area: 'East', custodian: 'Carol', mark: 'found' },
      { tag: 'D4', area: 'West', custodian: 'Dave', mark: 'pending' },
      { tag: 'D5', area: 'East', custodian: 'Eve', mark: 'pending' },
      { tag: 'D6', area: 'West', custodian: 'Fred', mark: 'pending' },
      { tag: 'D7', area: 'East', custodian: 'Heidi', mark: 'pending' },
      { tag: 'D8', area: 'East', custodian: 'Ivy', mark: 'pending' },
    ];
    const model = new Model();
    model.load(initial);

    const lib = new InventoryLedger(path);
    lib.initLedger(initial);

    const scope = ['East', 'North', 'South'];
    // 三个重叠任务，共享同一冻结时点
    const t1 = lib.openTask(scope);
    const b1 = model.snapshot();
    const s1 = model.now();
    const t2 = lib.openTask(scope);
    const b2 = model.snapshot();
    const s2 = model.now();
    const t3 = lib.openTask(scope);
    const b3 = model.snapshot();
    const s3 = model.now();

    const scan1: ScanEntry[] = [
      { tag: 'D1', area: 'East', custodian: 'Alice' },
      { tag: 'D2', area: 'North', custodian: 'Frank' },
      { tag: 'D4', area: 'East', custodian: 'Dave' },
      { tag: 'D5', area: 'East', custodian: 'Eve' },
    ];
    const scan2: ScanEntry[] = [
      { tag: 'D1', area: 'East', custodian: 'Alice' },
      { tag: 'D2', area: 'North', custodian: 'Frank' },
      { tag: 'D5', area: 'East', custodian: 'Eve' },
      { tag: 'D8', area: 'East', custodian: 'Ivy' },
    ];
    const scan3: ScanEntry[] = [
      { tag: 'D1', area: 'East', custodian: 'Alice' },
      { tag: 'D2', area: 'South', custodian: 'Hank' },
      { tag: 'D5', area: 'East', custodian: 'Eve' },
      { tag: 'D7', area: 'East', custodian: 'Heidi' },
    ];
    lib.submitResult(t1, scan1);
    lib.submitResult(t2, scan2);
    lib.submitResult(t3, scan3);

    // 差异清单与独立模型一致（判定不随后续账册变化而改变，先记录预期）
    const expectedDiffs1 = model.diffs(b1, scope, scan1);
    const expectedDiffs2 = model.diffs(b2, scope, scan2);
    const expectedDiffs3 = model.diffs(b3, scope, scan3);
    assert.deepEqual(
      expectedDiffs1.map((d) => [d.tag, d.kinds]),
      [
        ['D2', ['location', 'custodian']],
        ['D3', ['missing']],
        ['D4', ['surplus']],
        ['D7', ['missing']],
        ['D8', ['missing']],
      ],
    );

    // 审批 T1：正常落账
    const r1 = lib.approve(t1);
    assert.ok(r1.ok);
    const m1 = model.approve(b1, s1, scope, scan1);
    assert.ok(m1.ok);
    assert.deepEqual(sortedItems(r1.adjustment.items), sortedItems(m1.changes));

    // 任务开启后的日常调拨：D6 与盘点无关；D5 只有 mark 参与，位置/保管人变化兼容
    lib.transfer('D6', 'North', 'Grace');
    model.transfer('D6', 'North', 'Grace');
    lib.transfer('D5', 'South', 'Gina');
    model.transfer('D5', 'South', 'Gina');

    // 审批 T2：D1/D2/D5 与 T1 相同目标全部收敛，仅 D8 实际改变
    const r2 = lib.approve(t2);
    assert.ok(r2.ok);
    const m2 = model.approve(b2, s2, scope, scan2);
    assert.ok(m2.ok);
    assert.deepEqual(sortedItems(r2.adjustment.items), sortedItems(m2.changes));
    assert.deepEqual(r2.adjustment.items, [
      { tag: 'D8', field: 'mark', oldValue: 'pending', newValue: 'found' },
    ]);

    // 审批 T3：D2 目标与 T1 已落账值冲突，整单拒绝
    const r3 = lib.approve(t3);
    assert.ok(!r3.ok);
    const conflictFields = r3.conflicts.map((c) => `${c.tag}.${c.field}`).sort();
    assert.deepEqual(conflictFields, ['D2.area', 'D2.custodian']);
    // 整单不落账：T3 本应把 D7 标记为已找到，冲突后必须保持原值
    const d7 = lib.getLedger().find((d) => d.tag === 'D7')!;
    assert.equal(d7.mark, 'pending');
    // 不生成调整单，任务仍可重试
    const t3View = lib.getTaskResult(t3);
    assert.equal(t3View.status, 'open');
    assert.equal(t3View.adjustmentId, null);

    // 调拨 D2 到 T3 的目标值后重试：字段收敛，T3 成功
    lib.transfer('D2', 'South', 'Hank');
    model.transfer('D2', 'South', 'Hank');
    const r3b = lib.approve(t3);
    assert.ok(r3b.ok);
    const m3 = model.approve(b3, s3, scope, scan3);
    assert.ok(m3.ok);
    assert.deepEqual(sortedItems(r3b.adjustment.items), sortedItems(m3.changes));
    assert.deepEqual(r3b.adjustment.items, [
      { tag: 'D7', field: 'mark', oldValue: 'pending', newValue: 'found' },
    ]);

    // 差异清单判定基于冻结基线，不随账册变化而改变
    assert.deepEqual(lib.getTaskResult(t1).diffs, expectedDiffs1);
    assert.deepEqual(lib.getTaskResult(t2).diffs, expectedDiffs2);
    assert.deepEqual(lib.getTaskResult(t3).diffs, expectedDiffs3);

    // 最终账册与独立模型一致
    assert.deepEqual(lib.getLedger(), model.ledger());
    lib.close();
  } finally {
    cleanup();
  }
});

// ---------- 场景 2：短缺设备调出又调回仍被拦截 ----------

test('短缺设备任务开启后调出又调回，审批仍判冲突；无实际变化的调拨不拦截', () => {
  const { path, cleanup } = makeDb();
  try {
    const initial: Device[] = [
      { tag: 'M1', area: 'East', custodian: 'Alice', mark: 'found' },
      { tag: 'M2', area: 'East', custodian: 'Bob', mark: 'found' },
    ];
    const lib = new InventoryLedger(path);
    lib.initLedger(initial);

    const t1 = lib.openTask(['East']);
    // M1 调出又调回：位置与保管人曾实际变化
    lib.transfer('M1', 'West', 'Carol');
    lib.transfer('M1', 'East', 'Alice');
    // M2 的“调拨”新旧值相同，不构成实际变化
    lib.transfer('M2', 'East', 'Bob');

    // 两台设备都未扫描到，均为短缺
    lib.submitResult(t1, []);
    const result = lib.approve(t1);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.conflicts.map((c) => [c.tag, c.reason]),
      [['M1', 'missing-device-moved']],
    );
    // 整单不落账：M2 的标记也不能被改成“待查”
    const ledger = lib.getLedger();
    assert.equal(ledger.find((d) => d.tag === 'M1')!.mark, 'found');
    assert.equal(ledger.find((d) => d.tag === 'M2')!.mark, 'found');

    // 新建任务：基线冻结在调拨之后，两台设备的短缺都正常落账
    const t2 = lib.openTask(['East']);
    lib.submitResult(t2, []);
    const r2 = lib.approve(t2);
    assert.ok(r2.ok);
    assert.deepEqual(sortedItems(r2.adjustment.items), [
      { tag: 'M1', field: 'mark', oldValue: 'found', newValue: 'pending' },
      { tag: 'M2', field: 'mark', oldValue: 'found', newValue: 'pending' },
    ]);
    lib.close();
  } finally {
    cleanup();
  }
});

// ---------- 场景 3：成功审批后再调拨并重试审批 ----------

test('成功审批后再调拨并重试审批：账册不回滚、调整单不重复', () => {
  const { path, cleanup } = makeDb();
  try {
    const lib = new InventoryLedger(path);
    lib.initLedger([{ tag: 'A1', area: 'East', custodian: 'Alice', mark: 'pending' }]);

    const t = lib.openTask(['East', 'North']);
    lib.submitResult(t, [{ tag: 'A1', area: 'North', custodian: 'Bob' }]);
    const r1 = lib.approve(t);
    assert.ok(r1.ok);
    assert.deepEqual(sortedItems(r1.adjustment.items), [
      { tag: 'A1', field: 'area', oldValue: 'East', newValue: 'North' },
      { tag: 'A1', field: 'custodian', oldValue: 'Alice', newValue: 'Bob' },
      { tag: 'A1', field: 'mark', oldValue: 'pending', newValue: 'found' },
    ]);

    // 审批后的日常调拨必须保留
    lib.transfer('A1', 'South', 'Carol');

    // 重试审批：返回原调整单，不重新判断、不写账
    const r2 = lib.approve(t);
    assert.ok(r2.ok);
    assert.equal(r2.adjustment.id, r1.adjustment.id);
    assert.deepEqual(r2.adjustment, r1.adjustment);

    const after = lib.getLedger();
    assert.deepEqual(after, [{ tag: 'A1', area: 'South', custodian: 'Carol', mark: 'found' }]);
    assert.equal(lib.getTaskResult(t).adjustmentId, r1.adjustment.id);
    lib.close();
  } finally {
    cleanup();
  }
});

// ---------- 场景 4：持久化与输入校验 ----------

test('账册、任务与调整单持久化到 SQLite 文件，重开后状态完整', () => {
  const { path, cleanup } = makeDb();
  try {
    const initial: Device[] = [
      { tag: 'P1', area: 'East', custodian: 'Alice', mark: 'pending' },
      { tag: 'P2', area: 'East', custodian: 'Bob', mark: 'found' },
    ];
    const lib = new InventoryLedger(path);
    lib.initLedger(initial);
    const t = lib.openTask(['East']);
    lib.submitResult(t, [{ tag: 'P1', area: 'East', custodian: 'Alice' }]);
    const r = lib.approve(t);
    assert.ok(r.ok);
    lib.close();

    // 重新打开同一文件：账册、任务状态、调整单都在
    const lib2 = new InventoryLedger(path);
    assert.deepEqual(lib2.getLedger(), [
      { tag: 'P1', area: 'East', custodian: 'Alice', mark: 'found' },
      { tag: 'P2', area: 'East', custodian: 'Bob', mark: 'pending' },
    ]);
    const view = lib2.getTaskResult(t);
    assert.equal(view.status, 'approved');
    assert.equal(view.adjustmentId, r.adjustment.id);
    assert.deepEqual(
      view.diffs.map((d) => [d.tag, d.kinds]),
      [['P2', ['missing']]],
    );
    // 重开后重试审批仍返回原调整单
    const r2 = lib2.approve(t);
    assert.ok(r2.ok);
    assert.equal(r2.adjustment.id, r.adjustment.id);
    lib2.close();
  } finally {
    cleanup();
  }
});

test('输入校验：重复初始化、未登记标签、范围外区域、重复提交均被拒绝', () => {
  const { path, cleanup } = makeDb();
  try {
    const lib = new InventoryLedger(path);
    lib.initLedger([{ tag: 'V1', area: 'East', custodian: 'Alice', mark: 'pending' }]);
    assert.throws(() => lib.initLedger([{ tag: 'V2', area: 'East', custodian: 'Bob', mark: 'pending' }]));

    const t = lib.openTask(['East']);
    assert.throws(() => lib.submitResult(t, [{ tag: 'NOPE', area: 'East', custodian: 'X' }]));
    assert.throws(() => lib.submitResult(t, [{ tag: 'V1', area: 'West', custodian: 'Alice' }]));
    // 失败的提交不留痕迹，可以重新提交正确结果
    lib.submitResult(t, [{ tag: 'V1', area: 'East', custodian: 'Alice' }]);
    assert.throws(() => lib.submitResult(t, [{ tag: 'V1', area: 'East', custodian: 'Alice' }]));

    assert.throws(() => lib.transfer('NOPE', 'East', 'Alice'));
    assert.throws(() => lib.approve(999));
    // 未提交不能审批
    const t2 = lib.openTask(['East']);
    assert.throws(() => lib.approve(t2));
    lib.close();
  } finally {
    cleanup();
  }
});

// ---------- 场景 5：规模——50,000 台设备与 10 个同时待审批的任务 ----------

test('规模：50,000 台设备、10 个重叠任务可开启并全部审批落账', () => {
  const { path, cleanup } = makeDb();
  try {
    const lib = new InventoryLedger(path);
    const devices: Device[] = [];
    for (let i = 0; i < 50_000; i++) {
      devices.push({
        tag: `T${String(i).padStart(6, '0')}`,
        area: `A${i % 20}`,
        custodian: `C${i % 100}`,
        mark: 'pending',
      });
    }
    lib.initLedger(devices);

    const scope = Array.from({ length: 20 }, (_, i) => `A${i}`);
    const taskIds: number[] = [];
    for (let k = 0; k < 10; k++) taskIds.push(lib.openTask(scope));

    // 每个任务都提交整份结果：全部按账册现状扫描到
    const entries: ScanEntry[] = devices.map((d) => ({ tag: d.tag, area: d.area, custodian: d.custodian }));
    for (const t of taskIds) lib.submitResult(t, entries);

    // 交错审批：第一个任务实际改写 5 万个标记，其余 9 个全部收敛
    const adjustments = new Set<number>();
    for (const t of taskIds) {
      const r = lib.approve(t);
      assert.ok(r.ok);
      adjustments.add(r.adjustment.id);
    }
    assert.equal(adjustments.size, 10);
    assert.equal(lib.getLedger().filter((d) => d.mark === 'found').length, 50_000);
    lib.close();
  } finally {
    cleanup();
  }
});

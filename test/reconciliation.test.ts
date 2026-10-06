import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InventoryReconciliation,
  type ApproveResult,
  type LedgerEntry,
  type Mark,
  type ScanRecord,
} from "../src/index.js";

function makeLib(): { lib: InventoryReconciliation; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "inv-rec-"));
  const dbPath = join(dir, "inventory.db");
  return { lib: new InventoryReconciliation(dbPath), dir, dbPath };
}

function ledgerMap(lib: InventoryReconciliation): Map<string, LedgerEntry> {
  return new Map(lib.getLedger().map((entry) => [entry.tag, entry]));
}

function mustOk(result: ApproveResult) {
  assert.ok(result.ok, `expected ok, got conflicts: ${JSON.stringify(result)}`);
  return result.adjustment;
}

function mustConflict(result: ApproveResult) {
  assert.ok(!result.ok, `expected conflicts, got ok: ${JSON.stringify(result)}`);
  return result.conflicts;
}

test("重叠任务并发审批：兼容变更合并、相同目标收敛、含冲突批次整单不落账", () => {
  const { lib, dir } = makeLib();
  try {
    lib.loadInitialLedger([
      { tag: "D1", area: "A", custodian: "张三", mark: "pending" },
      { tag: "D2", area: "A", custodian: "李四", mark: "found" },
      { tag: "D3", area: "Z", custodian: "王五", mark: "found" },
      { tag: "D4", area: "A", custodian: "赵六", mark: "found" },
    ]);
    const task1 = lib.openTask(["A"]);
    const task2 = lib.openTask(["A", "B"]);

    // 兼容变更：与任务参与字段无关的设备调拨
    lib.registerTransfer({ tag: "D3", area: "Y" });

    lib.submitResults(task1.id, [
      { tag: "D1", area: "A", custodian: "张三" },
      { tag: "D2", area: "A", custodian: "李四" },
      { tag: "D4", area: "A", custodian: "赵六" },
    ]);
    lib.submitResults(task2.id, [
      { tag: "D1", area: "A", custodian: "张三" },
      { tag: "D2", area: "A", custodian: "李四" },
      { tag: "D4", area: "A", custodian: "钱七" },
    ]);

    // task1 审批成功：D1 标记 pending->found，D3 的调拨不受影响
    const adj1 = mustOk(lib.approveTask(task1.id));
    assert.deepEqual(adj1.items, [
      { tag: "D1", field: "mark", from: "pending", to: "found" },
    ]);
    let ledger = ledgerMap(lib);
    assert.equal(ledger.get("D1")!.mark, "found");
    assert.equal(ledger.get("D3")!.area, "Y");

    // task2 与 task1 对 D1 目标相同（已收敛），但 D4 保管人目标与账册不同 -> 冲突
    lib.registerTransfer({ tag: "D4", custodian: "孙八" });
    const conflicts = mustConflict(lib.approveTask(task2.id));
    assert.deepEqual(conflicts, [
      {
        tag: "D4",
        field: "custodian",
        baseline: "赵六",
        current: "孙八",
        target: "钱七",
        reason: "changed",
      },
    ]);
    // 整单不落账：账册不变、无调整单、任务仍可重试
    ledger = ledgerMap(lib);
    assert.equal(ledger.get("D4")!.custodian, "孙八");
    assert.equal(lib.getAdjustment(task2.id), null);
    assert.equal(lib.getTask(task2.id).status, "submitted");

    // 把 D4 调到目标值（收敛）后重试成功；D1 已收敛不重复修改
    lib.registerTransfer({ tag: "D4", custodian: "钱七" });
    const adj2 = mustOk(lib.approveTask(task2.id));
    assert.deepEqual(adj2.items, []);
    assert.equal(ledgerMap(lib).get("D4")!.custodian, "钱七");
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("短缺设备调出又调回仍被拦截", () => {
  const { lib, dir } = makeLib();
  try {
    lib.loadInitialLedger([
      { tag: "D5", area: "C", custodian: "孙八", mark: "found" },
      { tag: "D6", area: "C", custodian: "周九", mark: "found" },
    ]);
    const task = lib.openTask(["C"]);
    // 任务开启后调出又调回基线值
    lib.registerTransfer({ tag: "D5", area: "D" });
    lib.registerTransfer({ tag: "D5", area: "C" });
    // 只扫描到 D6，D5 短缺
    lib.submitResults(task.id, [{ tag: "D6", area: "C", custodian: "周九" }]);

    const diffs = lib.getDiffs(task.id);
    assert.deepEqual(
      diffs.map((d) => ({ tag: d.tag, kinds: d.kinds })),
      [{ tag: "D5", kinds: ["shortage"] }],
    );

    // 当前值等于基线值，但曾实际变化过 -> 冲突
    const conflicts = mustConflict(lib.approveTask(task.id));
    assert.deepEqual(conflicts, [
      {
        tag: "D5",
        field: "mark",
        baseline: "found",
        current: "found",
        target: "pending",
        reason: "touched_after_open",
      },
    ]);
    assert.equal(ledgerMap(lib).get("D5")!.mark, "found");
    assert.equal(lib.getAdjustment(task.id), null);
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("成功审批后再调拨并重试审批：账册不回滚、调整单不重复", () => {
  const { lib, dir } = makeLib();
  try {
    lib.loadInitialLedger([
      { tag: "D7", area: "E", custodian: "周九", mark: "pending" },
      { tag: "D8", area: "E", custodian: "吴十", mark: "found" },
    ]);
    const task = lib.openTask(["E"]);
    lib.submitResults(task.id, [
      { tag: "D7", area: "E", custodian: "周九" },
      { tag: "D8", area: "E", custodian: "吴十" },
    ]);
    const adj = mustOk(lib.approveTask(task.id));
    assert.deepEqual(adj.items, [
      { tag: "D7", field: "mark", from: "pending", to: "found" },
    ]);

    // 审批成功后再调拨
    lib.registerTransfer({ tag: "D7", area: "F", custodian: "郑一" });

    // 重试审批：返回原调整单，不重新判断、不写账
    const again = mustOk(lib.approveTask(task.id));
    assert.equal(again.id, adj.id);
    assert.deepEqual(again.items, adj.items);

    const ledger = ledgerMap(lib);
    assert.equal(ledger.get("D7")!.area, "F");
    assert.equal(ledger.get("D7")!.custodian, "郑一");
    assert.equal(ledger.get("D7")!.mark, "found");
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("基线冻结不受后续变化影响，差异清单与独立预期一致", () => {
  const { lib, dir } = makeLib();
  try {
    const initial: LedgerEntry[] = [
      { tag: "E1", area: "A", custodian: "甲", mark: "pending" },
      { tag: "E2", area: "A", custodian: "乙", mark: "found" },
      { tag: "E3", area: "B", custodian: "丙", mark: "found" },
      { tag: "E4", area: "A", custodian: "丁", mark: "found" },
      { tag: "E5", area: "B", custodian: "戊", mark: "pending" },
    ];
    lib.loadInitialLedger(initial);
    const task = lib.openTask(["A"]);

    // 任务开启后的变化不能修改基线
    lib.registerTransfer({ tag: "E3", area: "A", custodian: "丙2" });
    lib.registerTransfer({ tag: "E4", custodian: "丁2" });

    const scans: ScanRecord[] = [
      { tag: "E1", area: "A", custodian: "甲" }, // 仅标记差异 pending->found
      { tag: "E2", area: "A", custodian: "乙2" }, // 保管人差异
      { tag: "E3", area: "A", custodian: "丙2" }, // 盈余（基线在 B）
      // E4 未扫描 -> 短缺
    ];
    lib.submitResults(task.id, scans);

    // 独立预期：由冻结基线 + 提交结果推导
    const baseline = new Map(initial.map((e) => [e.tag, e]));
    const scanned = new Map(scans.map((s) => [s.tag, s]));
    const expectedDiffs: { tag: string; kinds: string[] }[] = [];
    for (const entry of initial) {
      const scan = scanned.get(entry.tag);
      const inScope = entry.area === "A";
      if (!scan) {
        if (inScope && entry.mark !== "pending") {
          expectedDiffs.push({ tag: entry.tag, kinds: ["shortage"] });
        }
        continue;
      }
      if (!inScope) {
        expectedDiffs.push({ tag: entry.tag, kinds: ["surplus"] });
        continue;
      }
      const kinds: string[] = [];
      if (scan.area !== entry.area) kinds.push("location");
      if (scan.custodian !== entry.custodian) kinds.push("custodian");
      if (kinds.length > 0 || entry.mark !== "found") {
        expectedDiffs.push({ tag: entry.tag, kinds });
      }
    }
    expectedDiffs.sort((a, b) => a.tag.localeCompare(b.tag));

    const actualDiffs = lib.getDiffs(task.id).map((d) => ({ tag: d.tag, kinds: d.kinds }));
    assert.deepEqual(actualDiffs, expectedDiffs);

    // 独立预期：按基线 + 操作记录模拟审批规则得到最终账册
    const model = new Map(initial.map((e) => [e.tag, { ...e }]));
    // 已发生的调拨
    model.get("E3")!.area = "A";
    model.get("E3")!.custodian = "丙2";
    model.get("E4")!.custodian = "丁2";
    // 审批：E1 mark found（基线值->目标值）；E2 custodian 乙2（基线值->目标值）；
    // E3 盈余：area A 已收敛，custodian 丙2 已收敛，mark found 已收敛；
    // E4 短缺：任务开启后 custodian 实际变化过 -> 冲突 -> 整单不落账
    const result = lib.approveTask(task.id);
    const conflicts = mustConflict(result);
    assert.deepEqual(conflicts, [
      {
        tag: "E4",
        field: "mark",
        baseline: "found",
        current: "found",
        target: "pending",
        reason: "touched_after_open",
      },
    ]);
    assert.deepEqual(lib.getLedger(), [...model.values()].sort((a, b) => a.tag.localeCompare(b.tag)));

    // 消除冲突：把 E4 调回基线保管人仍无效（曾变化），改为扫描目标外的方式无法解决，
    // 只能重新开任务。验证失败后重试仍返回冲突。
    lib.registerTransfer({ tag: "E4", custodian: "丁" });
    const retry = lib.approveTask(task.id);
    assert.ok(!retry.ok);
    assert.equal(retry.conflicts[0].reason, "touched_after_open");
    assert.equal(baseline.get("E4")!.custodian, "丁");
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("持久化：重开数据库后账册、任务、基线与调整单保持一致", () => {
  const { lib, dir, dbPath } = makeLib();
  let taskId = 0;
  let adjId = 0;
  try {
    lib.loadInitialLedger([
      { tag: "P1", area: "A", custodian: "甲", mark: "pending" },
      { tag: "P2", area: "A", custodian: "乙", mark: "found" },
    ]);
    const task = lib.openTask(["A"]);
    taskId = task.id;
    lib.submitResults(taskId, [
      { tag: "P1", area: "A", custodian: "甲" },
      { tag: "P2", area: "A", custodian: "乙" },
    ]);
    adjId = mustOk(lib.approveTask(taskId)).id;
    lib.registerTransfer({ tag: "P1", area: "B" });
  } finally {
    lib.close();
  }

  const lib2 = new InventoryReconciliation(dbPath);
  try {
    const ledger = ledgerMap(lib2);
    assert.equal(ledger.get("P1")!.mark, "found");
    assert.equal(ledger.get("P1")!.area, "B");
    assert.equal(lib2.getTask(taskId).status, "approved");
    const adj = lib2.getAdjustment(taskId);
    assert.ok(adj);
    assert.equal(adj.id, adjId);
    assert.deepEqual(adj.items, [
      { tag: "P1", field: "mark", from: "pending", to: "found" },
    ]);
    // 基线仍是开启时点：P1 基线区域为 A
    const diffs = lib2.getDiffs(taskId);
    const p1 = diffs.find((d) => d.tag === "P1");
    assert.ok(p1);
    assert.equal(p1.baseline.area, "A");
  } finally {
    lib2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("规模冒烟：50,000 台设备与 10 个待审批任务", () => {
  const { lib, dir } = makeLib();
  try {
    const count = 50_000;
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        tag: `T${i.toString().padStart(6, "0")}`,
        area: `R${i % 20}`,
        custodian: `C${i % 100}`,
        mark: (i % 3 === 0 ? "pending" : "found") as Mark,
      });
    }
    lib.loadInitialLedger(entries);

    const tasks = [];
    for (let t = 0; t < 10; t++) {
      tasks.push(lib.openTask([`R${t}`]));
    }
    // 扫描 R0 内全部设备并提交
    const scans: ScanRecord[] = entries
      .filter((e) => e.area === "R0")
      .map((e) => ({ tag: e.tag, area: e.area, custodian: e.custodian }));
    lib.submitResults(tasks[0].id, scans);
    const adj = mustOk(lib.approveTask(tasks[0].id));
    const expectedChanges = scans.filter((_, i) => entries[i].mark === "pending").length;
    assert.equal(adj.items.length, expectedChanges);
    assert.equal(lib.getLedger().length, count);
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

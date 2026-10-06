import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentGateBasis, GatePreview, ShipCycle } from "../src/index";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "shipcycle-"));
  return {
    path: join(dir, "gate.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function componentOf(preview: GatePreview, componentId: string): ComponentGateBasis {
  const component = preview.basis.components.find((c) => c.componentId === componentId);
  assert.ok(component, `component ${componentId} in basis`);
  return component;
}

test("共享组件双 P0 阻塞：逐步解除，实际状态与门禁始终等于从当前事实重算", async () => {
  const { path, cleanup } = tempDb();
  try {
    const sc = new ShipCycle(path);
    await sc.initRelease({ releaseId: "R1", componentIds: ["C1"], checklistItems: [{ itemId: "g1" }] });
    await sc.initRelease({ releaseId: "R2", componentIds: ["C1"], checklistItems: [{ itemId: "g2" }] });

    // 两个 P0 阻塞同时存在；期望设为 Ready 也被自动阻塞（期望本身保持 Ready）。
    await sc.applyBatch("R1", {
      bugUpdates: [
        { componentId: "C1", bugId: "b1", severity: "P0", status: "Open" },
        { componentId: "C1", bugId: "b2", severity: "P0", status: "In Progress" },
      ],
      expectationUpdates: [{ componentId: "C1", expected: "Ready" }],
    });
    let r1 = await sc.previewGate("R1");
    let c1 = componentOf(r1, "C1");
    assert.equal(c1.expected, "Ready", "自动阻塞不覆盖保存的期望状态");
    assert.equal(c1.actual, "Blocked");
    assert.deepEqual(c1.blockingP0BugIds, ["b1", "b2"]);
    assert.equal(r1.releasable, false);
    // 共享组件的 R2 同样被阻塞。
    const r2 = await sc.previewGate("R2");
    assert.equal(componentOf(r2, "C1").actual, "Blocked");
    assert.deepEqual(componentOf(r2, "C1").blockingP0BugIds, ["b1", "b2"]);

    // 乱序提交测试：先提交完成时间更晚但不达标的，再补一条完成时间更早的达标记录。
    await sc.applyBatch("R1", {
      tests: [
        { componentId: "C1", testId: "t200a", passed: 90, total: 100, completedAt: 200 },
        { componentId: "C1", testId: "t100", passed: 100, total: 100, completedAt: 100 },
      ],
    });
    r1 = await sc.previewGate("R1");
    assert.equal(componentOf(r1, "C1").latestTest?.testId, "t200a", "最新测试取完成时间最晚者");
    assert.equal(componentOf(r1, "C1").latestTest?.meetsThreshold, false);

    // 同时间测试：取标识字典序最大者。
    await sc.applyBatch("R1", {
      tests: [{ componentId: "C1", testId: "t200b", passed: 100, total: 100, completedAt: 200 }],
    });
    r1 = await sc.previewGate("R1");
    assert.equal(componentOf(r1, "C1").latestTest?.testId, "t200b");
    assert.equal(componentOf(r1, "C1").latestTest?.meetsThreshold, true);

    // 解除第一个 P0：仍被第二个阻塞。
    await sc.applyBatch("R2", {
      bugUpdates: [{ componentId: "C1", bugId: "b1", severity: "P0", status: "Resolved" }],
    });
    r1 = await sc.previewGate("R1");
    assert.equal(componentOf(r1, "C1").actual, "Blocked");
    assert.deepEqual(componentOf(r1, "C1").blockingP0BugIds, ["b2"]);

    // 解除第二个 P0：无需再次手工设置，按当前事实重算为 Ready。
    await sc.applyBatch("R1", {
      bugUpdates: [{ componentId: "C1", bugId: "b2", severity: "P0", status: "Closed" }],
    });
    r1 = await sc.previewGate("R1");
    c1 = componentOf(r1, "C1");
    assert.equal(c1.actual, "Ready");
    assert.equal(c1.expected, "Ready");
    assert.deepEqual(c1.blockingP0BugIds, []);
    assert.equal(r1.releasable, false, "清单未完成仍不可发布");
    assert.ok(r1.blockers.some((b) => b.reason === "CHECKLIST_INCOMPLETE"));

    await sc.applyBatch("R1", { checklistUpdates: [{ itemId: "g1", done: true }] });
    r1 = await sc.previewGate("R1");
    assert.equal(r1.releasable, true);
    assert.deepEqual(r1.blockers, []);

    // R2 的期望仍是 Not Started，阻塞解除后按自己的事实重算。
    const r2After = await sc.previewGate("R2");
    assert.equal(componentOf(r2After, "C1").actual, "Not Started");
    sc.close();
  } finally {
    cleanup();
  }
});

test("无关变更不使凭据失效；相关事实改走再改回，旧凭据仍被拒绝", async () => {
  const { path, cleanup } = tempDb();
  try {
    const sc = new ShipCycle(path);
    await sc.initRelease({ releaseId: "R3", componentIds: ["A"], checklistItems: [{ itemId: "ga" }] });
    await sc.initRelease({ releaseId: "R4", componentIds: ["B"], checklistItems: [{ itemId: "gb" }] });
    await sc.applyBatch("R3", {
      expectationUpdates: [{ componentId: "A", expected: "Ready" }],
      tests: [{ componentId: "A", testId: "ta1", passed: 95, total: 100, completedAt: 1000 }],
      checklistUpdates: [{ itemId: "ga", done: true }],
    });
    assert.equal((await sc.previewGate("R3")).releasable, true);

    // 相关事实改走：旧凭据失效。
    const t0 = (await sc.previewGate("R3")).token;
    await sc.applyBatch("R3", { expectationUpdates: [{ componentId: "A", expected: "Blocked" }] });
    // 再改回原值：旧凭据也不能复用。
    await sc.applyBatch("R3", { expectationUpdates: [{ componentId: "A", expected: "Ready" }] });
    assert.equal((await sc.previewGate("R3")).releasable, true, "事实已回到可发布状态");
    const stale = await sc.confirmRelease("R3", t0);
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? "", /expired/);

    // 无关发布更新、迟到旧测试、不改变 P0 阻塞集合的普通 Bug 更新：凭据保持有效。
    const t1 = (await sc.previewGate("R3")).token;
    await sc.applyBatch("R4", {
      expectationUpdates: [{ componentId: "B", expected: "In Progress" }],
      tests: [{ componentId: "B", testId: "tb1", passed: 1, total: 1, completedAt: 5 }],
      checklistUpdates: [{ itemId: "gb", done: true }],
    });
    await sc.applyBatch("R3", {
      tests: [{ componentId: "A", testId: "ta0-late", passed: 3, total: 100, completedAt: 500 }],
    });
    await sc.applyBatch("R3", {
      bugUpdates: [
        { componentId: "A", bugId: "minor1", severity: "P1", status: "Open" },
        { componentId: "A", bugId: "p0-closed", severity: "P0", status: "Closed" },
      ],
    });
    const preview = await sc.previewGate("R3");
    assert.equal(componentOf(preview, "A").latestTest?.testId, "ta1", "迟到记录未成为最新测试");
    const confirmed = await sc.confirmRelease("R3", t1);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.status, "Released");

    // 同一发布只能成功确认一次。
    const again = await sc.confirmRelease("R3", t1);
    assert.equal(again.ok, false);
    assert.match(again.error ?? "", /already/);
    sc.close();
  } finally {
    cleanup();
  }
});

test("共享组件的 P0 变化经其它发布生效，同样使本发布凭据失效", async () => {
  const { path, cleanup } = tempDb();
  try {
    const sc = new ShipCycle(path);
    await sc.initRelease({ releaseId: "R5", componentIds: ["S"], checklistItems: [{ itemId: "i5" }] });
    await sc.initRelease({ releaseId: "R6", componentIds: ["S"], checklistItems: [{ itemId: "i6" }] });
    await sc.applyBatch("R5", {
      expectationUpdates: [{ componentId: "S", expected: "Ready" }],
      tests: [{ componentId: "S", testId: "ts1", passed: 100, total: 100, completedAt: 10 }],
      checklistUpdates: [{ itemId: "i5", done: true }],
    });
    const token = (await sc.previewGate("R5")).token;
    await sc.applyBatch("R6", {
      bugUpdates: [{ componentId: "S", bugId: "shared-p0", severity: "P0", status: "Open" }],
    });
    const result = await sc.confirmRelease("R5", token);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /expired/);
    sc.close();
  } finally {
    cleanup();
  }
});

test("确认与新增 P0 交错：要么先发布并保留当时依据，要么 P0 先生效使确认失败", async () => {
  const { path, cleanup } = tempDb();
  try {
    // 顺序一：P0 先生效 -> 确认失败，不留 Released 状态。
    const sc = new ShipCycle(path);
    await sc.initRelease({ releaseId: "RA", componentIds: ["C"], checklistItems: [{ itemId: "ia" }] });
    await sc.initRelease({ releaseId: "RB", componentIds: ["C"], checklistItems: [{ itemId: "ib" }] });
    await sc.applyBatch("RA", {
      expectationUpdates: [{ componentId: "C", expected: "Ready" }],
      tests: [{ componentId: "C", testId: "t1", passed: 100, total: 100, completedAt: 1 }],
      checklistUpdates: [{ itemId: "ia", done: true }],
    });
    const tokenA = (await sc.previewGate("RA")).token;
    await sc.applyBatch("RB", {
      bugUpdates: [{ componentId: "C", bugId: "p0-late", severity: "P0", status: "Open" }],
    });
    const failed = await sc.confirmRelease("RA", tokenA);
    assert.equal(failed.ok, false);
    assert.equal((await sc.previewGate("RA")).status, "Planning");
    assert.equal(await sc.getReleasedBasis("RA"), null, "失败的确认不得留下成功记录");
    sc.close();

    // 顺序二：确认先完成 -> 之后共享组件的 P0 不回写当次发布记录。
    const sc2 = new ShipCycle(path);
    await sc2.initRelease({ releaseId: "RC", componentIds: ["D"], checklistItems: [{ itemId: "ic" }] });
    await sc2.initRelease({ releaseId: "RD", componentIds: ["D"], checklistItems: [{ itemId: "id" }] });
    await sc2.applyBatch("RC", {
      expectationUpdates: [{ componentId: "D", expected: "Ready" }],
      tests: [{ componentId: "D", testId: "t1", passed: 100, total: 100, completedAt: 1 }],
      checklistUpdates: [{ itemId: "ic", done: true }],
    });
    const tokenC = (await sc2.previewGate("RC")).token;
    const ok = await sc2.confirmRelease("RC", tokenC);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.basis?.components[0]?.blockingP0BugIds, []);
    await sc2.applyBatch("RD", {
      bugUpdates: [{ componentId: "D", bugId: "p0-after", severity: "P0", status: "Open" }],
    });
    const basis = await sc2.getReleasedBasis("RC");
    assert.deepEqual(basis?.components[0]?.blockingP0BugIds, [], "发布后的 Bug 变化不回写当次依据");

    // 并发交错：结果必须等价于两种完整顺序之一，绝不出现依据含阻塞却确认成功。
    await sc2.initRelease({ releaseId: "RE", componentIds: ["E"], checklistItems: [{ itemId: "ie" }] });
    await sc2.initRelease({ releaseId: "RF", componentIds: ["E"], checklistItems: [{ itemId: "if" }] });
    await sc2.applyBatch("RE", {
      expectationUpdates: [{ componentId: "E", expected: "Ready" }],
      tests: [{ componentId: "E", testId: "t1", passed: 100, total: 100, completedAt: 1 }],
      checklistUpdates: [{ itemId: "ie", done: true }],
    });
    const tokenE = (await sc2.previewGate("RE")).token;
    const [confirmResult] = await Promise.all([
      sc2.confirmRelease("RE", tokenE),
      sc2.applyBatch("RF", {
        bugUpdates: [{ componentId: "E", bugId: "p0-race", severity: "P0", status: "Open" }],
      }),
    ]);
    const basisE = await sc2.getReleasedBasis("RE");
    if (confirmResult.ok) {
      assert.deepEqual(basisE?.components[0]?.blockingP0BugIds, [], "确认成功时依据不得包含已生效的阻塞");
    } else {
      assert.equal(basisE, null, "确认失败不得留下 Released 记录");
      assert.equal((await sc2.previewGate("RE")).status, "Planning");
    }
    sc2.close();
  } finally {
    cleanup();
  }
});

test("关闭重开后发布记录仍可读取；期望为 Ready 但无测试或 total 为 0 均不达标", async () => {
  const { path, cleanup } = tempDb();
  try {
    const sc = new ShipCycle(path);
    await sc.initRelease({ releaseId: "RP", componentIds: ["M"], checklistItems: [{ itemId: "ip" }] });
    await sc.applyBatch("RP", {
      expectationUpdates: [{ componentId: "M", expected: "Ready" }],
      checklistUpdates: [{ itemId: "ip", done: true }],
    });
    sc.close();

    const reopened = new ShipCycle(path);
    let preview = await reopened.previewGate("RP");
    assert.equal(componentOf(preview, "M").actual, "In Progress", "没有测试不达标");
    assert.equal(preview.releasable, false);

    await reopened.applyBatch("RP", {
      tests: [{ componentId: "M", testId: "tz", passed: 0, total: 0, completedAt: 1 }],
    });
    preview = await reopened.previewGate("RP");
    assert.equal(componentOf(preview, "M").latestTest?.meetsThreshold, false, "total 为 0 不达标");
    assert.equal(componentOf(preview, "M").actual, "In Progress");

    await reopened.applyBatch("RP", {
      tests: [{ componentId: "M", testId: "tq", passed: 94, total: 100, skipped: 6, completedAt: 2 }],
    });
    preview = await reopened.previewGate("RP");
    assert.equal(componentOf(preview, "M").latestTest?.passRate, 0.94, "skipped 计入分母");
    assert.equal(componentOf(preview, "M").actual, "In Progress");

    await reopened.applyBatch("RP", {
      tests: [{ componentId: "M", testId: "tok", passed: 95, total: 100, completedAt: 3 }],
    });
    preview = await reopened.previewGate("RP");
    assert.equal(preview.releasable, true);
    const done = await reopened.confirmRelease("RP", preview.token);
    assert.equal(done.ok, true);

    // 再次重开：Released 状态与依据仍在。
    reopened.close();
    const again = new ShipCycle(path);
    const released = await again.previewGate("RP");
    assert.equal(released.status, "Released");
    assert.ok((await again.getReleasedBasis("RP")) !== null);
    again.close();
  } finally {
    cleanup();
  }
});

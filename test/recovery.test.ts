import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SETS_PER_SEGMENT, TrainingStore } from "../src/index";
import { fillSegmentOps, keyOf, setPosInSegment, tempDbPath } from "./helpers";

const EMP = "emp-rec";
const EXERCISES = ["squat"];

test("输入中途退出并重开：未提交批次没有任何影响", async () => {
  const dbPath = tempDbPath();
  const store = new TrainingStore(dbPath);
  await store.createCycle(EMP, EXERCISES);
  const committed = await store.beginBatch(EMP, "committed");
  await committed.add({
    key: keyOf(EMP, "squat", 1, 1, 1),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  await committed.commit();

  // 批次输入到一半，进程直接退出（不提交、不 abort）。
  const half = await store.beginBatch(EMP, "half-input");
  await half.add({
    key: keyOf(EMP, "squat", 1, 1, 2),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  await half.add({
    key: keyOf(EMP, "squat", 1, 1, 3),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  await store.close();

  const reopened = new TrainingStore(dbPath);
  const state1 = await reopened.getSetState(EMP, "squat", 1, 1, 1);
  assert.deepEqual(state1.entry, { weightLbs: 40, reps: 10 });
  for (const set of [2, 3]) {
    const state = await reopened.getSetState(EMP, "squat", 1, 1, set);
    assert.equal(state.version, 0, "未提交批次不能留下记录");
    assert.equal(state.entry, null);
  }
  const reader = await reopened.openReader(EMP);
  const seg1 = await reader.readSegment(1);
  assert.equal(
    seg1.exercises[0]?.sets.filter(Boolean).length,
    1,
    "视图中只能看到已提交的一组",
  );
  await reopened.close();
});

test("提交成功但回复丢失：重传凭据不变，且不覆盖之后的更正", async () => {
  const dbPath = tempDbPath();
  const store = new TrainingStore(dbPath);
  await store.createCycle(EMP, EXERCISES);

  // 批次 B 提交成功，但假设回复丢失。
  const batch = await store.beginBatch(EMP, "batch-B");
  await batch.add({
    key: keyOf(EMP, "squat", 1, 1, 1),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  const receipt = await batch.commit();

  // 之后另一批次更正了同一组。
  const fix = await store.beginBatch(EMP, "batch-C");
  await fix.add({
    key: keyOf(EMP, "squat", 1, 1, 1),
    baseVersion: 1,
    entry: { weightLbs: 45, reps: 12 },
  });
  const fixReceipt = await fix.commit();
  await store.close();

  // 重开后以相同内容重传 B：即使其组版本已过时，也只返回首次凭据。
  const reopened = new TrainingStore(dbPath);
  const replay = await reopened.beginBatch(EMP, "batch-B");
  await replay.add({
    key: keyOf(EMP, "squat", 1, 1, 1),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  const replayReceipt = await replay.commit();
  assert.equal(replayReceipt.commitId, receipt.commitId);
  assert.equal(replayReceipt.committedVersion, receipt.committedVersion);

  // 重传不能覆盖之后已经成功的更正，也不能产生新版本。
  const state = await reopened.getSetState(EMP, "squat", 1, 1, 1);
  assert.deepEqual(state.entry, { weightLbs: 45, reps: 12 });
  assert.equal(state.version, 2);
  const reader = await reopened.openReader(EMP);
  assert.equal(reader.committedVersion, fixReceipt.committedVersion);
  await reopened.close();
});

test("真实进程退出：已提交数据完整保留，重传不产生新版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "train-crash-"));
  const dbPath = join(dir, "crash.db");
  const childScript = join(dir, "child.cjs");
  const childSource = `
    const { TrainingStore } = require(${JSON.stringify(join(process.cwd(), "dist/src/index.js"))});
    (async () => {
      const store = new TrainingStore(${JSON.stringify(dbPath)});
      await store.createCycle(${JSON.stringify(EMP)}, ${JSON.stringify(EXERCISES)});
      const b = await store.beginBatch(${JSON.stringify(EMP)}, "child-batch");
      await b.add({
        key: { employeeId: ${JSON.stringify(EMP)}, exerciseId: "squat", week: 1, session: 1, set: 1 },
        baseVersion: 0,
        entry: { weightLbs: 40, reps: 10 },
      });
      const receipt = await b.commit();
      // 模拟回复丢失：凭据写入文件供父进程比对，随后立即退出。
      require("node:fs").writeFileSync(${JSON.stringify(join(dir, "receipt.json"))}, JSON.stringify(receipt));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  require("node:fs").writeFileSync(childScript, childSource);
  const run = spawnSync(process.execPath, ["--no-warnings", childScript], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);

  const receipt = JSON.parse(
    require("node:fs").readFileSync(join(dir, "receipt.json"), "utf8"),
  ) as { commitId: string; committedVersion: number };

  // 父进程重开：已提交批次的记录与凭据完整保留。
  const store = new TrainingStore(dbPath);
  const state = store.getSetState(EMP, "squat", 1, 1, 1);
  return state.then(async (s) => {
    assert.deepEqual(s.entry, { weightLbs: 40, reps: 10 });
    assert.equal(s.version, 1);

    // 重传同一批次：返回相同凭据，不产生新版本。
    const replay = await store.beginBatch(EMP, "child-batch");
    await replay.add({
      key: keyOf(EMP, "squat", 1, 1, 1),
      baseVersion: 0,
      entry: { weightLbs: 40, reps: 10 },
    });
    const replayReceipt = await replay.commit();
    assert.equal(replayReceipt.commitId, receipt.commitId);
    assert.equal(replayReceipt.committedVersion, receipt.committedVersion);
    const reader = await store.openReader(EMP);
    assert.equal(reader.committedVersion, receipt.committedVersion);
    await store.close();
  });
});

test("同一批次的并发重传只产生一次提交", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);

  async function submitSame(): Promise<{
    commitId: string;
    committedVersion: number;
  }> {
    const b = await store.beginBatch(EMP, "dup-batch");
    await b.add({
      key: keyOf(EMP, "squat", 2, 1, 1),
      baseVersion: 0,
      entry: { weightLbs: 40, reps: 10 },
    });
    return b.commit();
  }
  const receipts = await Promise.all([
    submitSame(),
    submitSame(),
    submitSame(),
  ]);
  const ids = new Set(receipts.map((r) => r.commitId));
  const versions = new Set(receipts.map((r) => r.committedVersion));
  assert.equal(ids.size, 1, "并发重传只能产生一个提交凭据");
  assert.equal(versions.size, 1);
  const state = await store.getSetState(EMP, "squat", 2, 1, 1);
  assert.equal(state.version, 1, "内容只被应用一次");
  await store.close();
});

test("撤回也算更改：撤回后旧版本的重叠提交被拒绝", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);
  const seed = await store.beginBatch(EMP, "seed");
  for (const op of fillSegmentOps(EMP, "squat", 1, 0, {
    weightLbs: 40,
    reps: 10,
  })) {
    await seed.add(op);
  }
  await seed.commit();

  // 撤回一组（版本 1 -> 2）。
  const pos = setPosInSegment(1, 0);
  const wd = await store.beginBatch(EMP, "withdraw");
  await wd.add({
    key: keyOf(EMP, "squat", pos.week, pos.session, pos.set),
    baseVersion: 1,
  });
  await wd.commit();

  // 依据撤回前版本 1 的提交必须被拒绝。
  const stale = await store.beginBatch(EMP, "stale");
  await stale.add({
    key: keyOf(EMP, "squat", pos.week, pos.session, pos.set),
    baseVersion: 1,
    entry: { weightLbs: 40, reps: 10 },
  });
  await assert.rejects(stale.commit(), /expected version 1, current 2/);

  // 撤回生效：该组记录为空，但版本保留为 2。
  const state = await store.getSetState(EMP, "squat", pos.week, pos.session, pos.set);
  assert.equal(state.version, 2);
  assert.equal(state.entry, null);
  const reader = await store.openReader(EMP);
  const seg1 = await reader.readSegment(1);
  assert.equal(
    seg1.exercises[0]?.sets.filter(Boolean).length,
    SETS_PER_SEGMENT - 1,
  );
  await store.close();
});

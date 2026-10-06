import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRenderQueue } from "../src/renderQueue";
import { JobSnapshot } from "../src/types";
import {
  Deferred,
  StageHarness,
  deferred,
  makeInputFile,
  pathExists,
} from "./helpers";

interface Fixture {
  root: string;
  outputDir: string;
  workRoot: string;
  inputDir: string;
  harness: StageHarness;
  cleanupWaiters: Map<string, Deferred<void>[]>;
  awaitCleanup: (jobId: string) => Promise<void>;
  makeQueue: (hooks?: {
    beforePublish?: (jobId: string) => void | Promise<void>;
  }) => ReturnType<typeof createRenderQueue>;
  snapshot: (id: string) => JobSnapshot;
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rq-test-"));
  const outputDir = path.join(root, "out");
  const workRoot = path.join(root, "work");
  const inputDir = path.join(root, "in");
  const harness = new StageHarness();
  const cleanupWaiters = new Map<string, Deferred<void>[]>();
  let queue: ReturnType<typeof createRenderQueue>;
  const fixture: Fixture = {
    root,
    outputDir,
    workRoot,
    inputDir,
    harness,
    cleanupWaiters,
    awaitCleanup: (jobId) =>
      new Promise<void>((resolve) => {
        const list = cleanupWaiters.get(jobId) ?? [];
        const d = deferred<void>();
        d.promise.then(resolve);
        list.push(d);
        cleanupWaiters.set(jobId, list);
      }),
    makeQueue: (hooks) => {
      queue = createRenderQueue({
        runStage: harness.runStage,
        outputDir,
        workRoot,
        hooks: {
          afterCleanup: (jobId) => {
            for (const d of cleanupWaiters.get(jobId) ?? []) d.resolve();
          },
          ...(hooks?.beforePublish
            ? { beforePublish: hooks.beforePublish }
            : {}),
        },
      });
      return queue;
    },
    snapshot: (id) => {
      const snap = queue.snapshot(id);
      assert.ok(snap, `snapshot for ${id}`);
      return snap;
    },
  };
  return fixture;
}

test("槽位占满后取消不响应 AbortSignal 的作业：cancel 先返回，槽位归还后按优先级与提交顺序启动，迟到产物被清理", async () => {
  const fx = await makeFixture();
  const q = fx.makeQueue();
  const h = fx.harness;

  // 占满 10 个物理槽位
  const runningIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const input = await makeInputFile(fx.inputDir, `r${i}.bin`);
    runningIds.push(q.submit(input, "normal"));
  }
  await h.waitForCallCount(10);
  assert.equal(h.calls.length, 10);
  assert.ok(h.calls.every((c) => !c.settled), "10 个阶段调用同时未结束");

  // 两个等待者：W1 先提交(normal)，W2 后提交(low)
  const w1 = q.submit(await makeInputFile(fx.inputDir, "w1.bin"), "normal");
  const w2 = q.submit(await makeInputFile(fx.inputDir, "w2.bin"), "low");
  assert.equal(fx.snapshot(w1).status, "queued");
  assert.equal(fx.snapshot(w2).status, "queued");

  // 取消一个执行器不响应 AbortSignal 的运行中作业
  const victim = runningIds[0]!;
  const victimCall = h.callsFor(victim, "compositing")[0]!;
  const victimCleanup = fx.awaitCleanup(victim);
  assert.equal(q.cancel(victim), true);
  assert.equal(q.cancel(victim), false, "重复取消返回 false");
  const victimSnap = fx.snapshot(victim);
  assert.equal(victimSnap.status, "cancelled", "cancel 返回后立即可见 cancelled");
  assert.equal(victimSnap.outputPath, null);

  // 执行器无视 AbortSignal 仍未结束：槽位未归还，等待者不得启动
  assert.equal(victimCall.settled, false);
  assert.equal(h.calls.length, 10, "槽位未归还，等待者不能提前启动");

  // 取消期间修改等待者优先级：W2 提为 high；running 作业不可改
  assert.equal(q.reprioritize(w2, "high"), true);
  assert.equal(q.reprioritize(runningIds[1]!, "low"), false);

  // 迟到产物返回：执行器停止后引擎收尾、归还槽位
  await victimCall.succeed();
  await victimCleanup;
  assert.equal(
    await pathExists(victimCall.workDir),
    false,
    "迟到产物与工作目录被清理"
  );
  assert.equal(fx.snapshot(victim).status, "cancelled", "迟到结果不改写终态");
  assert.equal(fx.snapshot(victim).outputPath, null);

  // 槽位真正归还后：high 的 W2 先启动，normal 的 W1 仍在等
  const w2Call = await h.waitForCall(w2, "compositing");
  assert.equal(h.callsFor(w1).length, 0);

  // W2 走完全部阶段释放槽位 → W1 按提交顺序补上
  await w2Call.succeed();
  await (await h.waitForCall(w2, "encoding")).succeed();
  await (await h.waitForCall(w2, "applyingEffects")).succeed();
  const w1Call = await h.waitForCall(w1, "compositing");
  assert.ok(w1Call);

  // 收尾：取消其余作业并让其执行器停止，避免悬挂
  const rest = [...runningIds.slice(1), w1];
  const restCleanups = rest.map((id) => fx.awaitCleanup(id));
  for (const id of rest) q.cancel(id);
  for (const id of rest) {
    const call = h.callsFor(id)[0];
    if (call && !call.settled) await call.succeed();
  }
  await Promise.all(restCleanups);
  assert.equal((await fs.readdir(fx.workRoot)).length, 0, "工作目录全部清理");
  for (let i = 0; i < 10; i++) {
    assert.equal(
      await pathExists(path.join(fx.inputDir, `r${i}.bin`)),
      true,
      "原始输入不得被删除"
    );
  }
});

test("前一阶段的迟到进度与取消后的迟到错误均不污染已确定状态", async () => {
  const fx = await makeFixture();
  const q = fx.makeQueue();
  const h = fx.harness;

  const id = q.submit(await makeInputFile(fx.inputDir, "a.bin"), "normal");
  const comp = await h.waitForCall(id, "compositing");

  comp.progress(0.3);
  assert.deepEqual(
    { stage: fx.snapshot(id).stage, progress: fx.snapshot(id).progress },
    { stage: "compositing", progress: 0.3 }
  );

  await comp.succeed();
  const enc = await h.waitForCall(id, "encoding");
  assert.deepEqual(
    { stage: fx.snapshot(id).stage, progress: fx.snapshot(id).progress },
    { stage: "encoding", progress: null },
    "新阶段开始时进度被重置"
  );

  comp.progress(0.9);
  assert.deepEqual(
    { stage: fx.snapshot(id).stage, progress: fx.snapshot(id).progress },
    { stage: "encoding", progress: null },
    "前一阶段的迟到进度不得污染新阶段"
  );

  enc.progress(0.5);
  assert.equal(fx.snapshot(id).progress, 0.5);

  const cleanup = fx.awaitCleanup(id);
  assert.equal(q.cancel(id), true);
  assert.equal(fx.snapshot(id).status, "cancelled");

  enc.fail(new Error("late boom"));
  enc.progress(0.99);
  await enc.done.catch(() => undefined);
  await cleanup;

  const snap = fx.snapshot(id);
  assert.equal(snap.status, "cancelled", "迟到错误不得改写 cancelled");
  assert.equal(snap.error, null);
  assert.equal(snap.progress, null, "取消后的迟到进度不得写入");
  assert.equal(snap.outputPath, null);
  assert.equal(await pathExists(enc.workDir), false, "工作目录被清理");
});

test("最终发布未结束时取消：cancel 成功、成品不暴露、迟到落盘文件被清除", async () => {
  const fx = await makeFixture();
  const publishStarted = deferred<void>();
  const publishGate = deferred<void>();
  const q = fx.makeQueue({
    beforePublish: () => {
      publishStarted.resolve();
      return publishGate.promise;
    },
  });
  const h = fx.harness;

  const id = q.submit(await makeInputFile(fx.inputDir, "p.bin"), "normal");
  await (await h.waitForCall(id, "compositing")).succeed();
  await (await h.waitForCall(id, "encoding")).succeed();
  await (await h.waitForCall(id, "applyingEffects")).succeed("final-content");

  await publishStarted.promise; // 发布已发起但未结束
  assert.equal(fx.snapshot(id).status, "running");

  const cleanup = fx.awaitCleanup(id);
  assert.equal(q.cancel(id), true, "发布进行中仍可成功取消");
  assert.equal(fx.snapshot(id).status, "cancelled");

  publishGate.resolve();
  await cleanup;

  const snap = fx.snapshot(id);
  assert.equal(snap.status, "cancelled");
  assert.equal(snap.outputPath, null, "先成功取消的作业不得暴露成品路径");
  assert.equal(
    (await fs.readdir(fx.outputDir)).length,
    0,
    "迟到落盘的成品文件被清除"
  );
  assert.equal((await fs.readdir(fx.workRoot)).length, 0);
});

test("completed 先可见后取消失败：成品可读、终态不可逆", async () => {
  const fx = await makeFixture();
  const q = fx.makeQueue();
  const h = fx.harness;

  const id = q.submit(await makeInputFile(fx.inputDir, "c.bin"), "high");
  await (await h.waitForCall(id, "compositing")).succeed();
  await (await h.waitForCall(id, "encoding")).succeed();
  await (await h.waitForCall(id, "applyingEffects")).succeed("final-content");

  const cleanup = fx.awaitCleanup(id);
  await cleanup;

  const snap = fx.snapshot(id);
  assert.equal(snap.status, "completed");
  assert.ok(snap.outputPath, "completed 必须给出成品路径");
  assert.equal(
    await fs.readFile(snap.outputPath!, "utf8"),
    "final-content",
    "成品已落盘可读"
  );
  assert.equal(q.cancel(id), false, "completed 后取消失败");
  assert.equal(fx.snapshot(id).status, "completed");
  assert.equal(
    (await fs.readdir(fx.workRoot)).length,
    0,
    "中间文件已清理"
  );
  assert.equal(
    (await fs.readdir(fx.outputDir)).length,
    1,
    "成品保留在发布目录"
  );
});

test("failed 作业自动清理且终态不可逆", async () => {
  const fx = await makeFixture();
  const q = fx.makeQueue();
  const h = fx.harness;

  const id = q.submit(await makeInputFile(fx.inputDir, "f.bin"), "normal");
  const comp = await h.waitForCall(id, "compositing");
  const cleanup = fx.awaitCleanup(id);
  comp.fail(new Error("render exploded"));
  await cleanup;

  const snap = fx.snapshot(id);
  assert.equal(snap.status, "failed");
  assert.equal(snap.error, "render exploded");
  assert.equal(snap.outputPath, null);
  assert.equal(await pathExists(comp.workDir), false, "failed 作业工作目录被清理");
  assert.equal(q.cancel(id), false, "failed 为终态，取消失败");
  assert.equal(fx.snapshot(id).status, "failed");
});

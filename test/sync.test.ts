import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ApplyResult,
  Batch,
  FileSink,
  FileSourceStore,
  Sink,
  SyncEngine,
  openLocalStack,
} from "../src/index";

const OBJECTS = ["obj-a", "obj-b", "obj-c", "obj-d", "obj-e"];

class CrashError extends Error {}

/** 丢弃确认的接收端包装：入账照常，但按谓词返回未确认。 */
class NoAckSink implements Sink {
  calls = 0;
  constructor(
    private readonly inner: Sink,
    private readonly shouldDrop: (batch: Batch) => boolean,
  ) {}

  applyBatch(batch: Batch): ApplyResult {
    this.calls += 1;
    const result = this.inner.applyBatch(batch);
    if (this.shouldDrop(batch)) {
      return { ack: false };
    }
    return result;
  }

  totalOf(objectId: string): number {
    return this.inner.totalOf(objectId);
  }
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flowforge-test-"));
}

function deltaOf(seq: number): number {
  return ((seq * 7919) % 11) - 5;
}

function appendRecords(source: FileSourceStore, from: number, to: number): void {
  for (let seq = from; seq <= to; seq += 1) {
    source.append({
      seq,
      objectId: OBJECTS[seq % OBJECTS.length],
      delta: deltaOf(seq),
    });
  }
}

function summarizeRange(
  source: FileSourceStore,
  fromExclusive: number,
  toInclusive: number,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const record of source.readRange(fromExclusive, toInclusive)) {
    totals.set(
      record.objectId,
      (totals.get(record.objectId) ?? 0) + record.delta,
    );
  }
  return totals;
}

function snapshotTotals(sink: Sink): Map<string, number> {
  const totals = new Map<string, number>();
  for (const objectId of OBJECTS) {
    totals.set(objectId, sink.totalOf(objectId));
  }
  return totals;
}

function assertTotalsMatch(
  source: FileSourceStore,
  sink: Sink,
  toInclusive?: number,
): void {
  const expected = summarizeRange(
    source,
    0,
    toInclusive ?? source.maxSeq(),
  );
  for (const objectId of OBJECTS) {
    assert.strictEqual(
      sink.totalOf(objectId),
      expected.get(objectId) ?? 0,
      `total of ${objectId}`,
    );
  }
}

test("批次部分入账后进程退出，重启恢复并最终恰好一次入账", () => {
  const dir = freshDir();
  const crashed = openLocalStack(dir, {
    sinkHooks: {
      afterRecordApplied: (appliedInThisCall) => {
        if (appliedInThisCall === 300) {
          throw new CrashError("process exit mid batch");
        }
      },
    },
  });
  appendRecords(crashed.source, 1, 1500);
  assert.throws(() => crashed.engine.advance());

  // 重新打开同一份本地数据，模拟重启。
  const reopened = openLocalStack(dir);
  // 崩溃时只入账了第一批的前 300 条。
  assertTotalsMatch(reopened.source, reopened.sink, 300);

  const result = reopened.engine.advance();
  assert.strictEqual(result.roundCompleted, true);
  assert.strictEqual(result.highWater, 1500);
  assertTotalsMatch(reopened.source, reopened.sink);
});

test("整批入账完成但确认丢失，重启后重投返回既有确认且不重复入账", () => {
  const dir = freshDir();
  let loseAck = true;
  const crashed = openLocalStack(dir, {
    sinkHooks: {
      beforeAckReturned: () => {
        if (loseAck) {
          loseAck = false;
          throw new CrashError("process exit before ack returned");
        }
      },
    },
  });
  appendRecords(crashed.source, 1, 1200);
  assert.throws(() => crashed.engine.advance());

  const reopened = openLocalStack(dir);
  // 第一批 1000 条已完整入账，确认虽丢失但结果已落盘。
  assertTotalsMatch(reopened.source, reopened.sink, 1000);

  const result = reopened.engine.advance();
  assert.strictEqual(result.roundCompleted, true);
  assert.strictEqual(result.highWater, 1200);
  assertTotalsMatch(reopened.source, reopened.sink);
});

test("尾批不足 1000 条且待确认期间继续追加来源，原上界与批次身份不变", () => {
  const dir = freshDir();
  const stack = openLocalStack(dir);
  appendRecords(stack.source, 1, 1500);

  const noAckTail = new NoAckSink(stack.sink, (b) => b.id === "batch:1001:1500");
  const engine = new SyncEngine(stack.source, noAckTail, stack.progress);

  const first = engine.advance();
  assert.strictEqual(first.roundCompleted, false);
  assert.strictEqual(first.highWater, 1000);
  assert.strictEqual(noAckTail.calls, 5); // 整批 1 次 + 尾批 4 次

  // 尾批待确认期间追加 300 条：必须留给下一轮。
  appendRecords(stack.source, 1501, 1800);
  const second = engine.advance();
  assert.strictEqual(second.roundCompleted, false);
  assert.strictEqual(second.highWater, 1000);

  const status = engine.status();
  assert.strictEqual(status.round?.upperBound, 1500);
  const progressOnDisk = JSON.parse(
    fs.readFileSync(path.join(dir, "progress", "progress.json"), "utf8"),
  );
  assert.deepStrictEqual(
    progressOnDisk.round.batches.map((b: { id: string }) => b.id),
    ["batch:1:1000", "batch:1001:1500"],
  );

  // 恢复确认：原轮次以原批次身份完成。
  const recovered = new SyncEngine(stack.source, stack.sink, stack.progress);
  const third = recovered.advance();
  assert.strictEqual(third.roundCompleted, true);
  assert.strictEqual(third.highWater, 1500);

  // 后追加的记录在下一轮处理。
  const fourth = recovered.advance();
  assert.strictEqual(fourth.roundCompleted, true);
  assert.strictEqual(fourth.highWater, 1800);
  assertTotalsMatch(stack.source, stack.sink);
});

test("同一批次连续 4 次无法确认后返回未完成，再次推进继续原批次", () => {
  const dir = freshDir();
  const stack = openLocalStack(dir);
  appendRecords(stack.source, 1, 500);

  const dropAll = new NoAckSink(stack.sink, () => true);
  const engine = new SyncEngine(stack.source, dropAll, stack.progress);
  const first = engine.advance();
  assert.strictEqual(first.roundCompleted, false);
  assert.strictEqual(first.batchesAcked, 0);
  assert.strictEqual(first.highWater, 0);
  assert.strictEqual(dropAll.calls, 4);
  // 未获得确认不代表目标未入账：批次已完整入账，但水位不得推进。
  assertTotalsMatch(stack.source, stack.sink);

  // 重启后继续原轮次：重投返回既有确认，不重复入账。
  const reopened = openLocalStack(dir);
  const second = reopened.engine.advance();
  assert.strictEqual(second.roundCompleted, true);
  assert.strictEqual(second.highWater, 500);
  assertTotalsMatch(reopened.source, reopened.sink);
});

test("重复推进、重投已完成批次与重新打开数据都不改变已入账结果", () => {
  const dir = freshDir();
  const stack = openLocalStack(dir);
  appendRecords(stack.source, 1, 2300);
  stack.engine.advance();
  assertTotalsMatch(stack.source, stack.sink);
  const before = snapshotTotals(stack.sink);

  // 没有新来源记录时，再次推进不产生新的入账。
  const again = stack.engine.advance();
  assert.strictEqual(again.roundCompleted, true);
  assert.strictEqual(again.batchesAcked, 0);

  // 同批次完成后的重复投递返回既有确认。
  const batch1: Batch = {
    id: "batch:1:1000",
    fromSeq: 1,
    toSeq: 1000,
    records: stack.source.readRange(0, 1000),
  };
  assert.strictEqual(stack.sink.applyBatch(batch1).ack, true);

  // 重新打开同一份本地数据。
  const reopened = openLocalStack(dir);
  reopened.engine.advance();
  const after = snapshotTotals(reopened.sink);
  for (const objectId of OBJECTS) {
    assert.strictEqual(after.get(objectId), before.get(objectId));
  }
  assertTotalsMatch(reopened.source, reopened.sink);
});

test("无来源记录时推进不产生入账；非法顺序号被拒绝", () => {
  const dir = freshDir();
  const stack = openLocalStack(dir);
  assert.deepStrictEqual(stack.engine.advance(), {
    highWater: 0,
    roundCompleted: true,
    batchesAcked: 0,
  });

  stack.source.append({ seq: 5, objectId: "obj-a", delta: 3 });
  assert.throws(() =>
    stack.source.append({ seq: 5, objectId: "obj-a", delta: 1 }),
  );
  assert.throws(() =>
    stack.source.append({ seq: 2, objectId: "obj-a", delta: 1 }),
  );

  const result = stack.engine.advance();
  assert.strictEqual(result.highWater, 5);
  assert.strictEqual(stack.sink.totalOf("obj-a"), 3);
});

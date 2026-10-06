import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalReceiver } from "../src/receiver.js";
import { SourceStore } from "../src/sourceStore.js";
import { TargetStore } from "../src/targetStore.js";
import type { Batch, BatchAck, Receiver } from "../src/types.js";

/** A fresh temp directory per test; removed by cleanup(). */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flowforge-test-"));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function sourceFile(dir: string): string {
  return path.join(dir, "source.json");
}

export function targetFile(dir: string): string {
  return path.join(dir, "target.json");
}

export function progressFile(dir: string): string {
  return path.join(dir, "progress.json");
}

/** Append `count` records, cycling object ids obj-0 .. obj-(objects-1). */
export function appendRecords(source: SourceStore, count: number, objects: number, delta = 1): void {
  for (let i = 0; i < count; i += 1) {
    source.append("obj-" + String(i % objects), delta);
  }
}

/** Sorted [objectId, value] pairs, for stable deepEqual comparisons. */
export function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * Test double: fails the next `failuresLeft` submissions. Each failure applies
 * only the first `crashAfter` records of the batch (its real, persisted work)
 * and then "crashes" without returning an ack. With crashAfter >= batch size
 * this models "fully applied but ack lost". Afterwards delegates to a healthy
 * LocalReceiver over the same target.
 */
export class FlakyReceiver implements Receiver {
  public submissions: Array<{ batchId: string; size: number }> = [];
  private failuresLeft: number;
  private readonly crashAfter: number;
  private readonly onlyBatchId: string | null;
  private readonly target: TargetStore;
  private readonly inner: LocalReceiver;

  constructor(target: TargetStore, failures: number, crashAfter: number, onlyBatchId?: string) {
    this.target = target;
    this.inner = new LocalReceiver(target);
    this.failuresLeft = failures;
    this.crashAfter = crashAfter;
    this.onlyBatchId = onlyBatchId ?? null;
  }

  submitBatch(batch: Batch): BatchAck | null {
    this.submissions.push({ batchId: batch.batchId, size: batch.records.length });
    const targeted = this.onlyBatchId === null || this.onlyBatchId === batch.batchId;
    if (this.failuresLeft > 0 && targeted) {
      this.failuresLeft -= 1;
      const prefix = batch.records.slice(0, Math.min(this.crashAfter, batch.records.length));
      this.target.applyBatch(batch.batchId, prefix);
      throw new Error("receiver crashed before ack");
    }
    return this.inner.submitBatch(batch);
  }
}

/** Test double: never applies anything, never confirms. Counts submissions. */
export class SilentReceiver implements Receiver {
  public submissions: Array<{ batchId: string; size: number }> = [];

  submitBatch(batch: Batch): BatchAck | null {
    this.submissions.push({ batchId: batch.batchId, size: batch.records.length });
    return null;
  }
}

/** Healthy receiver that records every submission it sees. */
export class SpyReceiver implements Receiver {
  public submissions: Array<{ batchId: string; size: number }> = [];
  private readonly inner: LocalReceiver;

  constructor(target: TargetStore) {
    this.inner = new LocalReceiver(target);
  }

  submitBatch(batch: Batch): BatchAck | null {
    this.submissions.push({ batchId: batch.batchId, size: batch.records.length });
    return this.inner.submitBatch(batch);
  }
}

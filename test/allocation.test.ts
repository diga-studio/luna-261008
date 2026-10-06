import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NotRecoverableError,
  UnsupportedError,
  Volume,
} from "../src/index.js";
import {
  CLUSTER,
  buildRecord,
  cleanupTempDir,
  encodeRuns,
  makeTempDir,
  pattern,
  writeImage,
  type ImageLayout,
} from "./helpers.js";

const VOLUME_OFFSET = 2 * CLUSTER;
const CLUSTER_COUNT = 128;
const VOLUME_LENGTH = CLUSTER_COUNT * CLUSTER;
const RECORD_LCN = 3;

// 三个物理段：20-21、40-41、60（最后一个引用簇为 60）。
const RUNS = [
  { length: 2, delta: 20 },
  { length: 2, delta: 20 },
  { length: 1, delta: 20 },
];
const DATA = new Map([
  [20, pattern(5, 2 * CLUSTER)],
  [40, pattern(6, 2 * CLUSTER)],
  [60, pattern(7, CLUSTER)],
]);
const REAL_SIZE = 5 * CLUSTER - 7;

function makeRecord(options: { inUse?: boolean } = {}): Buffer {
  return buildRecord(
    {
      kind: "nonresident",
      runlist: encodeRuns(RUNS),
      highestVcn: 4,
      realSize: REAL_SIZE,
      initializedSize: REAL_SIZE,
    },
    options,
  );
}

async function openVolume(layout: ImageLayout): Promise<Volume> {
  return Volume.open({
    imagePath: layout.imagePath,
    volumeOffset: layout.volumeOffset,
    volumeLength: layout.volumeLength,
    bitmapPath: layout.bitmapPath,
  });
}

describe("allocation bitmap enforcement", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
  });

  after(async () => {
    await cleanupTempDir(dir);
  });

  it("rejects recovery when only the last referenced cluster is allocated", async () => {
    const layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      record: makeRecord(),
      recordLcn: RECORD_LCN,
      clusters: DATA,
      allocatedClusters: [60], // 仅最后一个引用簇被占用
    });
    const volume = await openVolume(layout);
    const output = join(dir, "last-cluster-taken.bin");
    try {
      const candidate = await volume.inspectRecord(layout.recordOffset);
      assert.equal(candidate.allClustersFree, false);
      await assert.rejects(
        volume.recover(layout.recordOffset, output),
        NotRecoverableError,
      );
      await assert.rejects(
        volume.readRange(layout.recordOffset, 0, 4096),
        NotRecoverableError,
      );
      // 拒绝恢复时不得留下输出文件。
      await assert.rejects(readFile(output), /ENOENT/);
    } finally {
      await volume.close();
    }
  });

  it("rejects recovery when the record is still marked in use", async () => {
    const layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      record: makeRecord({ inUse: true }),
      recordLcn: RECORD_LCN,
      clusters: DATA,
    });
    const volume = await openVolume(layout);
    const output = join(dir, "in-use.bin");
    try {
      const candidate = await volume.inspectRecord(layout.recordOffset);
      assert.equal(candidate.recordUnused, false);
      await assert.rejects(
        volume.recover(layout.recordOffset, output),
        NotRecoverableError,
      );
      await assert.rejects(readFile(output), /ENOENT/);
    } finally {
      await volume.close();
    }
  });

  it("recovers when every referenced cluster is free", async () => {
    const layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      record: makeRecord(),
      recordLcn: RECORD_LCN,
      clusters: DATA,
      allocatedClusters: [0, 19, 22, 61, 127], // 均未被引用
    });
    const volume = await openVolume(layout);
    const output = join(dir, "free.bin");
    try {
      await volume.recover(layout.recordOffset, output);
      const expected = Buffer.concat([
        pattern(5, 2 * CLUSTER),
        pattern(6, 2 * CLUSTER),
        pattern(7, CLUSTER),
      ]).subarray(0, REAL_SIZE);
      assert.deepEqual(await readFile(output), expected);
    } finally {
      await volume.close();
    }
  });
});

describe("unsupported forms", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
  });

  after(async () => {
    await cleanupTempDir(dir);
  });

  async function expectUnsupported(record: Buffer): Promise<void> {
    const layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      record,
      recordLcn: RECORD_LCN,
      clusters: new Map(),
    });
    const volume = await openVolume(layout);
    try {
      await assert.rejects(
        volume.inspectRecord(layout.recordOffset),
        UnsupportedError,
      );
    } finally {
      await volume.close();
    }
  }

  it("rejects compressed $DATA", async () => {
    await expectUnsupported(
      buildRecord({
        kind: "nonresident",
        runlist: encodeRuns([{ length: 1, delta: 20 }]),
        highestVcn: 0,
        realSize: 100,
        initializedSize: 100,
        flags: 0x0001,
      }),
    );
  });

  it("rejects encrypted $DATA", async () => {
    await expectUnsupported(
      buildRecord({
        kind: "nonresident",
        runlist: encodeRuns([{ length: 1, delta: 20 }]),
        highestVcn: 0,
        realSize: 100,
        initializedSize: 100,
        flags: 0x4000,
      }),
    );
  });

  it("rejects $DATA not starting at VCN 0", async () => {
    const record = buildRecord({
      kind: "nonresident",
      runlist: encodeRuns([{ length: 1, delta: 20 }]),
      highestVcn: 3,
      realSize: 100,
      initializedSize: 100,
    });
    // 手工把 lowest VCN 改为 3（首段在其它记录中）。
    record.writeBigUInt64LE(3n, 0x38 + 0x10);
    await expectUnsupported(record);
  });

  it("rejects extension records (non-zero base reference)", async () => {
    const record = buildRecord({ kind: "resident", content: pattern(9, 100) });
    record.writeBigUInt64LE(12345n, 0x20);
    await expectUnsupported(record);
  });

  it("rejects records without an unnamed $DATA attribute", async () => {
    // 只有命名流：把 $DATA 属性的名字长度设为非零。
    const record = buildRecord({ kind: "resident", content: pattern(9, 100) });
    record.writeUInt8(4, 0x38 + 0x09);
    await expectUnsupported(record);
  });
});

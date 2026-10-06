import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CorruptRecordError, Volume } from "../src/index.js";
import {
  CLUSTER,
  buildRecord,
  cleanupTempDir,
  makeTempDir,
  pattern,
  writeImage,
  type ImageLayout,
} from "./helpers.js";

const VOLUME_OFFSET = 3 * CLUSTER;
const CLUSTER_COUNT = 64;
const VOLUME_LENGTH = CLUSTER_COUNT * CLUSTER;
const RECORD_LCN = 5;

// 驻留内容从 0x50 开始，长度 944 恰好延伸到记录末尾，
// 覆盖两个扇区尾保护位置（510-511、1022-1023）。
const CONTENT = pattern(7, 944);

async function setup(
  dir: string,
  record: Buffer,
  truncateTo?: number,
): Promise<ImageLayout> {
  return writeImage({
    dir,
    volumeOffset: VOLUME_OFFSET,
    volumeLength: VOLUME_LENGTH,
    record,
    recordLcn: RECORD_LCN,
    clusters: new Map(),
    truncateTo,
  });
}

async function openVolume(layout: ImageLayout): Promise<Volume> {
  return Volume.open({
    imagePath: layout.imagePath,
    volumeOffset: layout.volumeOffset,
    volumeLength: layout.volumeLength,
    bitmapPath: layout.bitmapPath,
  });
}

describe("resident $DATA crossing fixup positions", () => {
  let dir: string;
  let layout: ImageLayout;
  let volume: Volume;

  before(async () => {
    dir = await makeTempDir();
    layout = await setup(dir, buildRecord({ kind: "resident", content: CONTENT }));
    volume = await openVolume(layout);
  });

  after(async () => {
    await volume.close();
    await cleanupTempDir(dir);
  });

  it("recovers resident content without altering bytes at fixup positions", async () => {
    const output = join(dir, "resident.bin");
    await volume.recover(layout.recordOffset, output);
    assert.deepEqual(await readFile(output), CONTENT);
  });

  it("reads ranges straddling both sector tails", async () => {
    assert.deepEqual(
      await volume.readRange(layout.recordOffset, 508, 8),
      CONTENT.subarray(508, 516),
    );
    assert.deepEqual(
      await volume.readRange(layout.recordOffset, 1020, 4),
      CONTENT.subarray(1020, 1024),
    );
    // 内容恰好在记录末尾结束，逻辑长度即内容长度。
    assert.equal(
      (await volume.readRange(layout.recordOffset, 944, 16)).length,
      0,
    );
  });

  it("reports the candidate as resident with no physical clusters", async () => {
    const candidate = await volume.inspectRecord(layout.recordOffset);
    assert.equal(candidate.resident, true);
    assert.equal(candidate.recordUnused, true);
    assert.equal(candidate.allClustersFree, true);
    assert.equal(candidate.logicalSize, CONTENT.length);
    assert.deepEqual(candidate.runs, []);
  });
});

describe("corrupt records", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
  });

  after(async () => {
    await cleanupTempDir(dir);
  });

  it("rejects a record whose first sector tail fails the fixup check", async () => {
    const record = buildRecord({ kind: "resident", content: CONTENT });
    record.writeUInt16LE(0xdead, 510); // 破坏第一个扇区尾保护值
    const layout = await setup(dir, record);
    const volume = await openVolume(layout);
    try {
      await assert.rejects(
        volume.inspectRecord(layout.recordOffset),
        CorruptRecordError,
      );
      await assert.rejects(
        volume.recover(layout.recordOffset, join(dir, "corrupt1.bin")),
        CorruptRecordError,
      );
    } finally {
      await volume.close();
    }
  });

  it("rejects a record whose last sector tail fails the fixup check", async () => {
    const record = buildRecord({ kind: "resident", content: CONTENT });
    record.writeUInt16LE(0xbeef, 1022); // 破坏末扇区尾保护值
    const layout = await setup(dir, record);
    const volume = await openVolume(layout);
    try {
      await assert.rejects(
        volume.inspectRecord(layout.recordOffset),
        CorruptRecordError,
      );
    } finally {
      await volume.close();
    }
  });

  it("rejects a record truncated mid-way through the last sector", async () => {
    const record = buildRecord({ kind: "resident", content: CONTENT });
    const recordEnd = VOLUME_OFFSET + RECORD_LCN * CLUSTER + 700;
    const layout = await setup(dir, record, recordEnd);
    const volume = await openVolume(layout);
    try {
      await assert.rejects(
        volume.inspectRecord(layout.recordOffset),
        CorruptRecordError,
      );
      await assert.rejects(
        volume.recover(layout.recordOffset, join(dir, "corrupt3.bin")),
        CorruptRecordError,
      );
    } finally {
      await volume.close();
    }
  });

  it("does not leave an output file behind for corrupt records", async () => {
    const record = buildRecord({ kind: "resident", content: CONTENT });
    record.writeUInt16LE(0xdead, 510);
    const layout = await setup(dir, record);
    const volume = await openVolume(layout);
    const output = join(dir, "should-not-exist.bin");
    try {
      await assert.rejects(volume.recover(layout.recordOffset, output));
      await assert.rejects(readFile(output), /ENOENT/);
    } finally {
      await volume.close();
    }
  });
});

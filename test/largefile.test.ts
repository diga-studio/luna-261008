import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Volume } from "../src/index.js";
import { ImageReader } from "../src/image.js";
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

const GiB = 1 << 30;
const MiB = 1 << 20;

// 卷起始位置位于 4 GiB 之后，检验高偏移寻址。
const VOLUME_OFFSET = 5 * GiB;
const CLUSTER_COUNT = 262144; // 1 GiB 卷
const VOLUME_LENGTH = CLUSTER_COUNT * CLUSTER;
const RECORD_LCN = 500;

const LCN_A = 200000;
const LCN_B = 1000;
const LCN_C = 151000;
const SPARSE_CLUSTERS = 127992;
const REAL_SIZE = 500 * MiB; // 恰好 128000 簇
const RUN2_START = (2 + SPARSE_CLUSTERS) * CLUSTER;
const RUN3_START = RUN2_START + 2 * CLUSTER;
const INIT_SIZE = RUN3_START + 512; // run3 仅前 512 字节已初始化

const dataA = pattern(101, 2 * CLUSTER);
const dataB = pattern(102, 2 * CLUSTER);
const dataC = pattern(103, 4 * CLUSTER);

function expectedSlice(offset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  const put = (start: number, data: Buffer) => {
    const s = Math.max(offset, start);
    const e = Math.min(offset + length, start + data.length);
    if (s < e) data.copy(out, s - offset, s - start, e - start);
  };
  put(0, dataA);
  put(RUN2_START, dataB);
  put(RUN3_START, dataC.subarray(0, 512));
  return out; // 其余区域（稀疏段、未初始化尾部）保持为零
}

describe("500 MiB file beyond 4 GiB", () => {
  let dir: string;
  let layout: ImageLayout;
  let volume: Volume;

  before(async () => {
    dir = await makeTempDir();
    const record = buildRecord({
      kind: "nonresident",
      runlist: encodeRuns([
        { length: 2, delta: LCN_A },
        { length: SPARSE_CLUSTERS, delta: null },
        { length: 2, delta: LCN_B - LCN_A }, // 大幅负位移
        { length: 4, delta: LCN_C - LCN_B },
      ]),
      highestVcn: 127999,
      realSize: REAL_SIZE,
      initializedSize: INIT_SIZE,
    });
    layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      record,
      recordLcn: RECORD_LCN,
      clusters: new Map([
        [LCN_A, dataA],
        [LCN_B, dataB],
        [LCN_C, dataC],
      ]),
      allocatedClusters: [0, 1, RECORD_LCN],
    });
    volume = await Volume.open({
      imagePath: layout.imagePath,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: VOLUME_LENGTH,
      bitmapPath: layout.bitmapPath,
    });
  });

  after(async () => {
    await volume.close();
    await cleanupTempDir(dir);
  });

  it("recovers the full 500 MiB file with bounded extra memory", async () => {
    const output = join(dir, "large.bin");
    const before = process.memoryUsage();
    await volume.recover(layout.recordOffset, output);
    const after = process.memoryUsage();

    const handle = await open(output, "r");
    try {
      assert.equal((await handle.stat()).size, REAL_SIZE);
      const check = async (offset: number, length: number) => {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        assert.deepEqual(buf, expectedSlice(offset, length), `at ${offset}`);
      };
      await check(0, 3 * CLUSTER); // run0 + 稀疏段起点
      await check(RUN2_START - 8, 2 * CLUSTER + 16); // 稀疏段 -> run2 -> run3
      await check(INIT_SIZE - 1024, 4096); // 已初始化边界
      await check(REAL_SIZE - 8192, 8192); // 未初始化尾部
    } finally {
      await handle.close();
    }
    // 单次操作额外工作内存远低于 64 MiB（流式 4 MiB 块）。
    assert.ok(
      after.external - before.external < 64 * MiB &&
        after.heapUsed - before.heapUsed < 64 * MiB,
      `memory grew too much: ${JSON.stringify({ before, after })}`,
    );
  });

  it("reads a 64 KiB range without touching unrelated file data", async () => {
    const reads: Array<{ offset: number; length: number }> = [];
    const original = ImageReader.prototype.readAt;
    ImageReader.prototype.readAt = function (offset, length, buf) {
      reads.push({ offset, length });
      return original.call(this, offset, length, buf);
    };
    try {
      // 窗口完整落在逻辑范围内，覆盖稀疏尾部、run2 全部与 run3 已初始化部分。
      const offset = RUN2_START - 49152;
      const slice = await volume.readRange(layout.recordOffset, offset, 65536);
      assert.deepEqual(slice, expectedSlice(offset, 65536));
    } finally {
      ImageReader.prototype.readAt = original;
    }
    // 镜像数据区读取量 = 请求区间与已初始化物理数据的真实交集。
    const dataBytes = reads
      .filter((r) => r.offset >= VOLUME_OFFSET)
      .reduce((sum, r) => sum + r.length, 0);
    assert.equal(dataBytes, 1024 + 8192 + 512); // 记录 + run2 + run3 已初始化部分
    // 含位图在内的全部读取远低于 1 MiB，不存在整文件扫描。
    const totalBytes = reads.reduce((sum, r) => sum + r.length, 0);
    assert.ok(totalBytes < MiB, `read ${totalBytes} bytes`);
  });

  it("serves ranges from the sparse middle as pure zeros", async () => {
    const offset = 250 * MiB;
    const slice = await volume.readRange(layout.recordOffset, offset, 65536);
    assert.deepEqual(slice, Buffer.alloc(65536));
  });
});

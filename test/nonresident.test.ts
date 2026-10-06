import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Volume } from "../src/index.js";
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

// 运行段布局：正位移 -> 稀疏段 -> 负位移（向后跳）-> 正位移。
// 稀疏段不改变相对位移基准：run2 的 -50 相对 run0 的 LCN 100。
const LCN_A = 100;
const LCN_B = 50;
const LCN_C = 60;
const REAL_SIZE = 8 * CLUSTER - 100; // 簇尾填充 100 字节不输出
const INIT_SIZE = 6 * CLUSTER + 1234; // 已初始化边界落在 run2 中部
const VOLUME_OFFSET = 5 * CLUSTER;
const CLUSTER_COUNT = 300;

const dataA = pattern(11, 2 * CLUSTER);
const dataB = pattern(22, 2 * CLUSTER);
const dataC = pattern(33, 1 * CLUSTER);

function expectedContent(): Buffer {
  const run2Start = 5 * CLUSTER;
  const initInRun2 = INIT_SIZE - run2Start;
  return Buffer.concat([
    dataA,
    Buffer.alloc(3 * CLUSTER), // 稀疏段读为零
    dataB.subarray(0, initInRun2),
    Buffer.alloc(REAL_SIZE - INIT_SIZE), // 未初始化尾部读为零
  ]);
}

describe("non-resident fragmented file", () => {
  let dir: string;
  let layout: ImageLayout;
  let volume: Volume;

  before(async () => {
    dir = await makeTempDir();
    const runlist = encodeRuns([
      { length: 2, delta: LCN_A },
      { length: 3, delta: null }, // 稀疏段
      { length: 2, delta: LCN_B - LCN_A }, // 负位移
      { length: 1, delta: LCN_C - LCN_B }, // 基准不受稀疏段影响
    ]);
    const record = buildRecord({
      kind: "nonresident",
      runlist,
      highestVcn: 7,
      realSize: REAL_SIZE,
      initializedSize: INIT_SIZE,
    });
    layout = await writeImage({
      dir,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: CLUSTER_COUNT * CLUSTER,
      record,
      recordLcn: 10,
      clusters: new Map([
        [LCN_A, dataA],
        [LCN_B, dataB],
        [LCN_C, dataC],
      ]),
      allocatedClusters: [0, 1, 2, 10, 200], // 引用簇全部空闲
    });
    volume = await Volume.open({
      imagePath: layout.imagePath,
      volumeOffset: VOLUME_OFFSET,
      volumeLength: CLUSTER_COUNT * CLUSTER,
      bitmapPath: layout.bitmapPath,
    });
  });

  after(async () => {
    await volume.close();
    await cleanupTempDir(dir);
  });

  it("inspects the record and reports the candidate", async () => {
    const candidate = await volume.inspectRecord(layout.recordOffset);
    assert.equal(candidate.recordUnused, true);
    assert.equal(candidate.resident, false);
    assert.equal(candidate.logicalSize, REAL_SIZE);
    assert.equal(candidate.initializedSize, INIT_SIZE);
    assert.equal(candidate.allClustersFree, true);
    assert.deepEqual(
      candidate.runs.map((r) => [r.vcn, r.lengthClusters, r.lcn]),
      [
        [0, 2, LCN_A],
        [2, 3, null],
        [5, 2, LCN_B],
        [7, 1, LCN_C],
      ],
    );
  });

  it("recovers the full file byte-for-byte", async () => {
    const output = join(dir, "recovered.bin");
    await volume.recover(layout.recordOffset, output);
    const recovered = await readFile(output);
    assert.equal(recovered.length, REAL_SIZE);
    assert.deepEqual(recovered, expectedContent());
  });

  it("reads ranges consistently with full recovery", async () => {
    const expected = expectedContent();
    const ranges: Array<[number, number]> = [
      [0, REAL_SIZE], // 全量
      [8192 - 16, 32], // 跨 run0 -> 稀疏段
      [20480 - 8, 64], // 跨稀疏段 -> run2
      [INIT_SIZE - 4, 8], // 跨已初始化边界
      [28672 - 4, 108], // 跨 run2 -> run3（未初始化）
      [REAL_SIZE - 10, 100], // 越过逻辑末尾：截断
    ];
    for (const [offset, length] of ranges) {
      const slice = await volume.readRange(layout.recordOffset, offset, length);
      assert.deepEqual(
        slice,
        expected.subarray(offset, Math.min(offset + length, REAL_SIZE)),
        `range [${offset}, +${length})`,
      );
    }
  });

  it("returns empty buffers for ranges beyond the logical end", async () => {
    assert.equal(
      (await volume.readRange(layout.recordOffset, REAL_SIZE, 100)).length,
      0,
    );
    assert.equal(
      (await volume.readRange(layout.recordOffset, REAL_SIZE + 4096, 100))
        .length,
      0,
    );
  });
});

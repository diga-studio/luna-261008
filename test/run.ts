import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CLUSTER_SIZE,
  NtfsRecovery,
  RecoveryError,
  type RecoveryOptions,
} from "../src/index.js";
import { buildBitmap, buildRecord, clusterPattern, type RecordSpec } from "./builder.js";
import { runAll, test } from "./harness.js";

const MiB = 1024 * 1024;

interface Fixture {
  dir: string;
  imagePath: string;
  bitmapPath: string;
  volumeOffset: number;
  volumeLength: number;
  recordOffset: number;
  options: RecoveryOptions;
}

interface FixtureSpec {
  volumeOffset: number;
  volumeClusters: number;
  recordCluster: number;
  record: RecordSpec;
  /** cluster -> content (defaults to clusterPattern(cluster)) */
  dataClusters: number[];
  usedClusters: number[];
  /** extra bytes appended past the volume end (to prove bounds checks) */
  imageTailBytes?: number;
}

function makeFixture(spec: FixtureSpec): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfsrec-"));
  const imagePath = path.join(dir, "image.dd");
  const bitmapPath = path.join(dir, "bitmap.bin");
  const volumeLength = spec.volumeClusters * CLUSTER_SIZE;
  const recordOffset = spec.volumeOffset + spec.recordCluster * CLUSTER_SIZE;
  const imageSize = spec.volumeOffset + volumeLength + (spec.imageTailBytes ?? 0);
  const fd = fs.openSync(imagePath, "w");
  try {
    fs.ftruncateSync(fd, imageSize);
    for (const cluster of spec.dataClusters) {
      fs.writeSync(fd, clusterPattern(cluster), 0, CLUSTER_SIZE, spec.volumeOffset + cluster * CLUSTER_SIZE);
    }
    const record = buildRecord(spec.record);
    fs.writeSync(fd, record, 0, record.length, recordOffset);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(bitmapPath, buildBitmap(spec.volumeClusters, spec.usedClusters));
  return {
    dir,
    imagePath,
    bitmapPath,
    volumeOffset: spec.volumeOffset,
    volumeLength,
    recordOffset,
    options: { volumeOffset: spec.volumeOffset, volumeLength, recordOffset },
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.dir, { recursive: true, force: true });
}

// A fragmented file: +delta run, sparse run, -delta run, +delta run,
// with an uninitialized tail. Expected content assembled independently.
const FRAG_RUNS = [
  { lcn: 10, lengthClusters: 2 }, // +10
  { lcn: null, lengthClusters: 1 }, // sparse
  { lcn: 5, lengthClusters: 1 }, // -5 (negative delta)
  { lcn: 20, lengthClusters: 2 }, // +15
];
const FRAG_INITIALIZED = 3 * CLUSTER_SIZE + 1000; // covers run A, sparse, 1000B of run B
const FRAG_REAL = FRAG_INITIALIZED + 5000; // tail beyond initialized reads as zero

function fragExpected(): Buffer {
  const parts: Buffer[] = [
    clusterPattern(10),
    clusterPattern(11),
    Buffer.alloc(CLUSTER_SIZE), // sparse
    clusterPattern(5).subarray(0, 1000),
  ];
  const head = Buffer.concat(parts);
  return Buffer.concat([head, Buffer.alloc(FRAG_REAL - head.length)]);
}

function fragFixture(usedClusters: number[]): Fixture {
  return makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record: {
      runs: FRAG_RUNS,
      realSize: FRAG_REAL,
      initializedSize: FRAG_INITIALIZED,
    },
    dataClusters: [10, 11, 5, 20, 21],
    usedClusters,
  });
}

test("fragmented non-resident: full recovery matches expected bytes", () => {
  const f = fragFixture([30, 31]); // unrelated clusters in use
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const info = rec.inspect();
    assert.strictEqual(info.recoverable, true);
    assert.strictEqual(info.resident, false);
    assert.strictEqual(info.logicalSize, FRAG_REAL);
    assert.strictEqual(info.initializedSize, FRAG_INITIALIZED);
    assert.strictEqual(info.runs.length, 4);
    assert.deepStrictEqual(
      info.runs.map((r) => r.lcn),
      [10, null, 5, 20],
    );
    const out = path.join(f.dir, "out.bin");
    const stats = rec.recoverToFile(out);
    assert.strictEqual(stats.bytesWritten, FRAG_REAL);
    assert.strictEqual(fs.statSync(out).size, FRAG_REAL);
    const expected = fragExpected();
    const actual = fs.readFileSync(out);
    assert.ok(actual.equals(expected), "recovered content mismatch");
    rec.close();
  } finally {
    cleanup(f);
  }
});

test("fragmented non-resident: range reads match slices of full recovery", () => {
  const f = fragFixture([]);
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const expected = fragExpected();
    const ranges: Array<[number, number]> = [
      [0, 100], // inside first run
      [CLUSTER_SIZE - 100, 200], // across clusters of run A
      [2 * CLUSTER_SIZE - 50, 200], // run A -> sparse boundary
      [3 * CLUSTER_SIZE - 10, 20], // sparse -> run B (negative delta)
      [3 * CLUSTER_SIZE + 500, 1000], // run B into beyond-initialized tail
      [4 * CLUSTER_SIZE, 64 * 1024], // 64 KiB range read across run C
      [FRAG_REAL - 10, 1000], // partially past EOF: truncated
      [FRAG_REAL, 100], // at EOF: empty
      [FRAG_REAL + 4096, 100], // beyond EOF: empty
      [0, FRAG_REAL], // whole file via range read
    ];
    for (const [off, len] of ranges) {
      const got = rec.readRange(off, len);
      const want = expected.subarray(off, Math.min(off + len, expected.length));
      assert.ok(got.equals(Buffer.from(want)), `range [${off}, +${len}) mismatch`);
    }
    rec.close();
  } finally {
    cleanup(f);
  }
});

function residentFixture(record: RecordSpec, usedClusters: number[]): Fixture {
  return makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record,
    dataClusters: [],
    usedClusters,
  });
}

// 600-byte resident value starts at record offset 0x50 and therefore crosses
// the sector-tail protection slots at 510-511 and 1022-1023.
const RESIDENT_DATA = (() => {
  const buf = Buffer.alloc(600);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (i * 31 + 7) & 0xff;
  }
  return buf;
})();

test("resident data crossing sector-tail fixup positions recovers intact", () => {
  // Every cluster marked in use: resident data references no physical clusters.
  const f = residentFixture({ residentData: RESIDENT_DATA }, Array.from({ length: 64 }, (_, i) => i));
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const info = rec.inspect();
    assert.strictEqual(info.recoverable, true);
    assert.strictEqual(info.resident, true);
    assert.strictEqual(info.logicalSize, RESIDENT_DATA.length);
    const out = path.join(f.dir, "resident.bin");
    rec.recoverToFile(out);
    assert.ok(fs.readFileSync(out).equals(RESIDENT_DATA), "resident content altered");
    assert.ok(rec.readRange(500, 100).equals(RESIDENT_DATA.subarray(500, 600)));
    rec.close();
  } finally {
    cleanup(f);
  }
});

test("record with wrong sector protection value is rejected and yields no file", () => {
  const f = residentFixture({ residentData: RESIDENT_DATA, breakFixupSector: 1 }, []);
  try {
    assert.throws(
      () => new NtfsRecovery(f.imagePath, f.bitmapPath, f.options),
      (err: unknown) => err instanceof RecoveryError && err.code === "CORRUPT_RECORD",
    );
    assert.strictEqual(fs.readdirSync(f.dir).filter((n) => n !== "image.dd" && n !== "bitmap.bin").length, 0);
  } finally {
    cleanup(f);
  }
});

test("truncated record (image ends mid-record) is rejected", () => {
  // Volume claims room for the record, but the image ends 100 bytes short.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfsrec-"));
  try {
    const imagePath = path.join(dir, "image.dd");
    const bitmapPath = path.join(dir, "bitmap.bin");
    const volumeOffset = MiB;
    const volumeLength = 64 * CLUSTER_SIZE;
    const recordOffset = volumeOffset + 40 * CLUSTER_SIZE;
    const fd = fs.openSync(imagePath, "w");
    fs.ftruncateSync(fd, recordOffset + 1024 - 100);
    fs.closeSync(fd);
    fs.writeFileSync(bitmapPath, buildBitmap(64, []));
    assert.throws(
      () =>
        new NtfsRecovery(imagePath, bitmapPath, { volumeOffset, volumeLength, recordOffset }),
      (err: unknown) => err instanceof RecoveryError && err.code === "OUT_OF_BOUNDS",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only the last referenced cluster in use: recovery refused, no output file", () => {
  // Cluster 21 is the final cluster of the final run.
  const f = fragFixture([21]);
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    assert.strictEqual(rec.inspect().recoverable, false);
    const out = path.join(f.dir, "refused.bin");
    assert.throws(
      () => rec.recoverToFile(out),
      (err: unknown) => err instanceof RecoveryError && err.code === "CLUSTERS_IN_USE",
    );
    assert.strictEqual(fs.existsSync(out), false, "output file must not be left behind");
    assert.throws(
      () => rec.readRange(0, 4096),
      (err: unknown) => err instanceof RecoveryError && err.code === "CLUSTERS_IN_USE",
    );
    rec.close();
  } finally {
    cleanup(f);
  }
});

test("record still marked in use is refused", () => {
  const f = makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record: { inUse: true, runs: FRAG_RUNS, realSize: FRAG_REAL, initializedSize: FRAG_INITIALIZED },
    dataClusters: [10, 11, 5, 20, 21],
    usedClusters: [],
  });
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    assert.strictEqual(rec.inspect().recoverable, false);
    const out = path.join(f.dir, "live.bin");
    assert.throws(
      () => rec.recoverToFile(out),
      (err: unknown) => err instanceof RecoveryError && err.code === "NOT_DELETED",
    );
    assert.strictEqual(fs.existsSync(out), false);
    assert.throws(
      () => rec.readRange(0, 1),
      (err: unknown) => err instanceof RecoveryError && err.code === "NOT_DELETED",
    );
    rec.close();
  } finally {
    cleanup(f);
  }
});

function expectReject(
  name: string,
  mutate: (record: Buffer) => void,
  code: string,
): void {
  test(name, () => {
    const f = makeFixture({
      volumeOffset: MiB,
      volumeClusters: 64,
      recordCluster: 40,
      record: { runs: FRAG_RUNS, realSize: FRAG_REAL, initializedSize: FRAG_INITIALIZED },
      dataClusters: [10, 11, 5, 20, 21],
      usedClusters: [],
    });
    try {
      // Mutate the record in place (away from fixup tail slots).
      const fd = fs.openSync(f.imagePath, "r+");
      const raw = Buffer.alloc(1024);
      fs.readSync(fd, raw, 0, 1024, f.recordOffset);
      mutate(raw);
      fs.writeSync(fd, raw, 0, 1024, f.recordOffset);
      fs.closeSync(fd);
      assert.throws(
        () => new NtfsRecovery(f.imagePath, f.bitmapPath, f.options),
        (err: unknown) => err instanceof RecoveryError && err.code === code,
      );
    } finally {
      cleanup(f);
    }
  });
}

const ATTR = 0x38; // first attribute offset used by the builder

expectReject("compressed $DATA is unsupported", (r) => {
  r.writeUInt16LE(0x0001, ATTR + 12);
}, "UNSUPPORTED");

expectReject("encrypted $DATA is unsupported", (r) => {
  r.writeUInt16LE(0x4000, ATTR + 12);
}, "UNSUPPORTED");

expectReject("attribute list (extension records) is unsupported", (r) => {
  r.writeUInt32LE(0x20, ATTR);
}, "UNSUPPORTED");

expectReject("start VCN != 0 is unsupported", (r) => {
  r.writeBigInt64LE(BigInt(4), ATTR + 16);
}, "UNSUPPORTED");

expectReject("attribute extending past record end is corrupt", (r) => {
  r.writeUInt32LE(4096, ATTR + 4);
}, "CORRUPT_RECORD");

expectReject("declared size exceeding runs is corrupt", (r) => {
  r.writeBigInt64LE(BigInt(100 * CLUSTER_SIZE), ATTR + 48);
}, "CORRUPT_ATTRIBUTE");

test("physical reference beyond volume boundary is rejected", () => {
  const f = makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record: {
      runs: [
        { lcn: 10, lengthClusters: 1 },
        { lcn: 63, lengthClusters: 2 }, // extends past 64-cluster volume
      ],
      realSize: 3 * CLUSTER_SIZE,
      initializedSize: 3 * CLUSTER_SIZE,
    },
    dataClusters: [10],
    usedClusters: [],
  });
  try {
    assert.throws(
      () => new NtfsRecovery(f.imagePath, f.bitmapPath, f.options),
      (err: unknown) => err instanceof RecoveryError && err.code === "OUT_OF_BOUNDS",
    );
  } finally {
    cleanup(f);
  }
});

test("record with only a named $DATA stream has no recoverable candidate", () => {
  const f = makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record: { namedData: { name: "secret", data: Buffer.alloc(16, 1) } },
    dataClusters: [],
    usedClusters: [],
  });
  try {
    assert.throws(
      () => new NtfsRecovery(f.imagePath, f.bitmapPath, f.options),
      (err: unknown) => err instanceof RecoveryError && err.code === "CORRUPT_ATTRIBUTE",
    );
  } finally {
    cleanup(f);
  }
});

test("named $DATA stream alongside unnamed data is ignored", () => {
  const f = makeFixture({
    volumeOffset: MiB,
    volumeClusters: 64,
    recordCluster: 40,
    record: {
      residentData: RESIDENT_DATA,
      namedData: { name: "ads", data: Buffer.alloc(32, 9) },
    },
    dataClusters: [],
    usedClusters: [],
  });
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const out = path.join(f.dir, "unnamed.bin");
    rec.recoverToFile(out);
    assert.ok(fs.readFileSync(out).equals(RESIDENT_DATA));
    rec.close();
  } finally {
    cleanup(f);
  }
});

test("record and data beyond 4 GiB are read correctly", () => {
  const f = makeFixture({
    volumeOffset: 5 * 1024 * MiB, // volume starts past the 4 GiB mark
    volumeClusters: 64,
    recordCluster: 40,
    record: { runs: FRAG_RUNS, realSize: FRAG_REAL, initializedSize: FRAG_INITIALIZED },
    dataClusters: [10, 11, 5, 20, 21],
    usedClusters: [],
  });
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const expected = fragExpected();
    const out = path.join(f.dir, "high.bin");
    rec.recoverToFile(out);
    assert.ok(fs.readFileSync(out).equals(expected), "high-offset recovery mismatch");
    assert.ok(rec.readRange(3 * CLUSTER_SIZE - 10, 200).equals(expected.subarray(3 * CLUSTER_SIZE - 10, 3 * CLUSTER_SIZE + 190)));
    rec.close();
  } finally {
    cleanup(f);
  }
});

const BIG_CLUSTERS = 128000; // 500 MiB logical file
const BIG_REAL = BIG_CLUSTERS * CLUSTER_SIZE;
const BIG_DATA_CLUSTERS = 128; // 512 KiB of real data at LCN 100
const BIG_INITIALIZED = (BIG_DATA_CLUSTERS + 1) * CLUSTER_SIZE; // + one sparse cluster

function bigFixture(): Fixture {
  return makeFixture({
    volumeOffset: MiB,
    volumeClusters: BIG_CLUSTERS,
    recordCluster: BIG_CLUSTERS - 1,
    record: {
      runs: [
        { lcn: 100, lengthClusters: BIG_DATA_CLUSTERS },
        { lcn: null, lengthClusters: BIG_CLUSTERS - BIG_DATA_CLUSTERS },
      ],
      realSize: BIG_REAL,
      initializedSize: BIG_INITIALIZED,
    },
    dataClusters: Array.from({ length: BIG_DATA_CLUSTERS }, (_, i) => 100 + i),
    usedClusters: [],
  });
}

function bigDataExpected(): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < BIG_DATA_CLUSTERS; i++) {
    parts.push(clusterPattern(100 + i));
  }
  return Buffer.concat(parts);
}

test("500 MiB file: 64 KiB range reads are exact and stay within memory budget", () => {
  const f = bigFixture();
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    assert.strictEqual(rec.inspect().logicalSize, BIG_REAL);
    const data = bigDataExpected();
    // Warm up allocator, then measure.
    rec.readRange(0, 64 * 1024);
    const rssBefore = process.memoryUsage().rss;
    const head = rec.readRange(0, 64 * 1024);
    assert.ok(head.equals(data.subarray(0, 64 * 1024)), "head range mismatch");
    const mid = rec.readRange(200 * CLUSTER_SIZE, 64 * 1024);
    assert.ok(mid.equals(Buffer.alloc(64 * 1024)), "sparse range must be zero");
    const edge = rec.readRange(BIG_DATA_CLUSTERS * CLUSTER_SIZE - 100, 200);
    const edgeWant = Buffer.concat([
      data.subarray(data.length - 100),
      Buffer.alloc(100),
    ]);
    assert.ok(edge.equals(edgeWant), "initialized/sparse edge mismatch");
    const tail = rec.readRange(BIG_REAL - 64 * 1024, 64 * 1024);
    assert.ok(tail.equals(Buffer.alloc(64 * 1024)), "uninitialized tail must be zero");
    const rssAfter = process.memoryUsage().rss;
    assert.ok(
      rssAfter - rssBefore < 64 * MiB,
      `range read used ${((rssAfter - rssBefore) / MiB).toFixed(1)} MiB extra memory`,
    );
    rec.close();
  } finally {
    cleanup(f);
  }
});

test("500 MiB file: full recovery streams within memory budget", () => {
  const f = bigFixture();
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const out = path.join(f.dir, "big.bin");
    const rssBefore = process.memoryUsage().rss;
    const stats = rec.recoverToFile(out);
    const rssAfter = process.memoryUsage().rss;
    assert.strictEqual(stats.bytesWritten, BIG_REAL);
    assert.strictEqual(fs.statSync(out).size, BIG_REAL);
    assert.ok(
      rssAfter - rssBefore < 64 * MiB,
      `full recovery used ${((rssAfter - rssBefore) / MiB).toFixed(1)} MiB extra memory`,
    );
    // Spot-check content without loading the whole 500 MiB output.
    const fd = fs.openSync(out, "r");
    const head = Buffer.alloc(64 * 1024);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    assert.ok(head.equals(bigDataExpected().subarray(0, 64 * 1024)), "recovered head mismatch");
    rec.close();
  } finally {
    cleanup(f);
  }
});

expectReject("runlist covering fewer clusters than declared is corrupt", (r) => {
  // FRAG_RUNS totals 6 clusters; claim last VCN 6 (i.e. 7 clusters).
  r.writeBigInt64LE(BigInt(6), ATTR + 24);
}, "CORRUPT_RUNLIST");

expectReject("runlist with missing terminator is corrupt", (r) => {
  // FRAG_RUNS encodes to 11 bytes; overwrite the terminator at offset 64+11.
  r.writeUInt8(0x11, ATTR + 64 + 11);
}, "CORRUPT_RUNLIST");

test("range read at image end does not read past requested bytes", () => {
  // Data cluster is the very last cluster of the image; the file's logical
  // size ends mid-cluster exactly at the image end. Any read past the
  // requested range would run off the end of the image and throw.
  const volumeClusters = 16;
  const realSize = CLUSTER_SIZE + 100; // 1 cluster + 100 bytes
  const f = makeFixture({
    volumeOffset: MiB,
    volumeClusters,
    recordCluster: 0,
    record: {
      runs: [
        { lcn: 4, lengthClusters: 1 },
        { lcn: volumeClusters - 1, lengthClusters: 1 }, // final cluster of image
      ],
      realSize,
      initializedSize: realSize,
    },
    dataClusters: [4, volumeClusters - 1],
    usedClusters: [],
  });
  try {
    const rec = new NtfsRecovery(f.imagePath, f.bitmapPath, f.options);
    const got = rec.readRange(CLUSTER_SIZE, 100);
    assert.strictEqual(got.length, 100);
    assert.ok(got.equals(clusterPattern(volumeClusters - 1).subarray(0, 100)));
    rec.close();
  } finally {
    cleanup(f);
  }
});

void runAll();

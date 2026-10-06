import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetStore } from "../src/store.js";
import { screenEmployees } from "../src/screening.js";
import type { CriminalRecord } from "../src/types.js";

const RECORDS: CriminalRecord[] = [
  { id: "R1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" },
  { id: "R2", nameKey: "lisi", ssn: "4321" },
];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "screening-store-"));
}

test("导入后持久化到本地文件，新实例可重新加载", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "dataset.json");
    new DatasetStore(file).importRecords(RECORDS);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as CriminalRecord[];
    assert.deepEqual(onDisk, RECORDS);

    const reloaded = new DatasetStore(file);
    assert.equal(reloaded.size, 2);
    assert.deepEqual(reloaded.snapshot(), RECORDS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件不存在时从空数据集开始", () => {
  const dir = tempDir();
  try {
    const store = new DatasetStore(join(dir, "missing.json"));
    assert.equal(store.size, 0);
    assert.deepEqual(store.snapshot(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重新导入整体替换数据集", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "dataset.json");
    const store = new DatasetStore(file);
    store.importRecords(RECORDS);
    store.importRecords([{ id: "R9", nameKey: "wangwu" }]);
    assert.deepEqual(new DatasetStore(file).snapshot(), [
      { id: "R9", nameKey: "wangwu" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("快照在筛查期间固定：后续导入不影响已取快照", () => {
  const dir = tempDir();
  try {
    const store = new DatasetStore(join(dir, "dataset.json"));
    store.importRecords(RECORDS);
    const snapshot = store.snapshot();
    store.importRecords([{ id: "R9", nameKey: "wangwu" }]);

    assert.deepEqual(snapshot, RECORDS);
    const results = screenEmployees(
      [{ id: "E1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }],
      snapshot,
    );
    assert.deepEqual(results[0]?.hits, [{ recordId: "R1", category: "exact" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("快照为拷贝：调用方修改记录对象不影响数据集", () => {
  const dir = tempDir();
  try {
    const store = new DatasetStore(join(dir, "dataset.json"));
    const mutable: CriminalRecord = { id: "R1", nameKey: "zhangsan" };
    store.importRecords([mutable]);
    mutable.nameKey = "tampered";
    const snapshot = store.snapshot();
    (snapshot[0] as CriminalRecord).nameKey = "tampered-again";
    assert.equal(store.snapshot()[0]?.nameKey, "zhangsan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

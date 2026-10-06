import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert";
import test from "node:test";
import type { ExperimentResults } from "../src/index.js";

const CHILD = path.resolve("dist/test/child/run_experiment.js");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "al-test-"));
}

function waitForFile(file: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${file}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function runChild(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", CHILD, ...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

async function killAtMarker(args: string[], markerFile: string): Promise<void> {
  const child = spawn(process.execPath, ["--experimental-sqlite", CHILD, ...args], { stdio: "ignore" });
  await waitForFile(markerFile);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

function baseline(dir: string): ExperimentResults {
  execFileSync(process.execPath, ["--experimental-sqlite", CHILD, "baseline", path.join(dir, "base.db"), path.join(dir, "base.json")]);
  return JSON.parse(fs.readFileSync(path.join(dir, "base.json"), "utf8"));
}

function countLabels(dbPath: string, strategy: string, roundNo: number): number {
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM round_labels WHERE strategy = ? AND round_no = ?")
    .get(strategy, roundNo) as { n: number };
  db.close();
  return row.n;
}

test("随机批次第7个标签落盘后终止：进展保留、轨迹停在上一轮、续跑与不间断一致", async () => {
  const dir = tmpdir();
  const expected = baseline(dir);

  const dbPath = path.join(dir, "crash.db");
  const idFile = path.join(dir, "id.txt");
  const marker = path.join(dir, "marker");
  await killAtMarker(["crash-labels", dbPath, idFile, marker, "random", "1", "7"], marker);

  // 7 条标签进展已落盘
  assert.strictEqual(countLabels(dbPath, "random", 1), 7);
  // 公开轨迹仍停在上一轮（第1轮未发布，轨迹为空）
  const db = new DatabaseSync(dbPath);
  const committed = db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE status = 'committed'").get() as { n: number };
  db.close();
  assert.strictEqual(committed.n, 0);

  // 续跑至完成，与不间断执行逐轮一致（含后续随机批次）
  const code = await runChild(["resume", dbPath, idFile, path.join(dir, "resumed.json")]);
  assert.strictEqual(code, 0);
  const actual: ExperimentResults = JSON.parse(fs.readFileSync(path.join(dir, "resumed.json"), "utf8"));
  assert.deepStrictEqual(actual.strategies, expected.strategies);
  // 7 条已落盘标签被复用而非重取：第1轮恰好 32 条，无重复
  assert.strictEqual(countLabels(dbPath, "random", 1), 32);
});

test("轮次发布后、runRound返回前终止：重试同轮返回原结果且不改变后续", async () => {
  const dir = tmpdir();
  const expected = baseline(dir);

  const dbPath = path.join(dir, "crash.db");
  const idFile = path.join(dir, "id.txt");
  const marker = path.join(dir, "marker");
  await killAtMarker(["crash-return", dbPath, idFile, marker, "uncertainty", "1"], marker);

  // 轮次已发布
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT selected_ids, cumulative_budget, validation_accuracy FROM rounds WHERE strategy = 'uncertainty' AND round_no = 1 AND status = 'committed'")
    .get() as { selected_ids: string; cumulative_budget: number; validation_accuracy: number };
  db.close();
  const published = {
    roundNo: 1,
    selectedIds: JSON.parse(row.selected_ids) as number[],
    cumulativeBudget: row.cumulative_budget,
    validationAccuracy: row.validation_accuracy,
  };

  // 重试同轮：返回原结果
  const outFile = path.join(dir, "retry.json");
  let code = await runChild(["run-one", dbPath, idFile, "uncertainty", "1", outFile]);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), published);

  // 续跑至完成，与不间断执行完全一致
  code = await runChild(["resume", dbPath, idFile, path.join(dir, "resumed.json")]);
  assert.strictEqual(code, 0);
  const actual: ExperimentResults = JSON.parse(fs.readFileSync(path.join(dir, "resumed.json"), "utf8"));
  assert.deepStrictEqual(actual.strategies, expected.strategies);
});

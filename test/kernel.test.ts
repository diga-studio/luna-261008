import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openKernel } from "../src/kernel";
import { classMeans, predict, selectUncertainty } from "../src/model";
import { ExperimentData, RoundResult, Strategy, STRATEGIES } from "../src/types";
import { DATA_SEED, EXP_SEED, makeData, runToCompletion } from "./helpers";

const CHILD = path.join(__dirname, "child.js");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "al-kernel-"));
}

function writeDataFile(dir: string, data: ExperimentData): string {
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function writeOpsFile(dir: string, ops: unknown[]): string {
  const file = path.join(dir, `ops-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(ops));
  return file;
}

interface ChildOutput {
  lines: string[];
  signal: NodeJS.Signals | null;
  code: number | null;
}

function runChild(
  dir: string,
  dbFile: string,
  ops: unknown[],
  hook?: unknown,
  killOnHook = false,
  expId?: string
): Promise<ChildOutput> {
  const opsFile = writeOpsFile(dir, ops);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dbFile, opsFile], {
      env: {
        ...process.env,
        ...(hook ? { AL_HOOK: JSON.stringify(hook) } : {}),
        ...(expId ? { AL_EXP_ID: expId } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        lines.push(line);
        if (killOnHook && line.startsWith("HOOK ")) {
          child.kill("SIGKILL");
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (!killOnHook && code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr}\n${lines.join("\n")}`));
      } else {
        resolve({ lines, signal, code });
      }
    });
  });
}

function createdId(out: ChildOutput): string {
  const line = out.lines.find((l) => l.startsWith("CREATED "));
  assert.ok(line, `missing CREATED line in ${out.lines.join("\n")}`);
  return line.slice("CREATED ".length);
}

function resultsOf(out: ChildOutput) {
  const line = out.lines.find((l) => l.startsWith("RESULTS "));
  assert.ok(line, `missing RESULTS line in ${out.lines.join("\n")}`);
  return JSON.parse(line.slice("RESULTS ".length));
}

function runAllRoundsOps(strategies: Strategy[], rounds: number): unknown[] {
  const ops: unknown[] = [];
  for (const s of strategies) for (let r = 1; r <= rounds; r++) ops.push({ op: "run", strategy: s, round: r });
  return ops;
}

function referenceTrajectory(dir: string, data: ExperimentData) {
  const kernel = openKernel(path.join(dir, "ref.db"));
  const expId = kernel.createExperiment(data, EXP_SEED);
  for (const s of STRATEGIES) runToCompletion(kernel, expId, s);
  const results = kernel.readResults(expId);
  kernel.close();
  return results;
}

test("model: tie predicts 0, uncertainty orders by margin then id", () => {
  const model = classMeans([
    { features: [0, 0], label: 0 },
    { features: [2, 2], label: 1 },
  ]);
  assert.equal(predict(model, [1, 1]), 0); // exactly between means -> tie -> 0
  const ids = selectUncertainty(
    [
      { id: 9, features: [1, 1] },
      { id: 3, features: [1, 1] },
      { id: 5, features: [0, 0] },
    ],
    model,
    2
  );
  assert.deepEqual(ids, [3, 9]); // tie on margin -> id ascending
});

test("recovery: kill during labeling, resume matches uninterrupted run", async () => {
  const dir = tmpdir();
  const data = makeData();
  const dataFile = writeDataFile(dir, data);
  const reference = referenceTrajectory(dir, data);
  const rounds = reference.strategies.random.length;
  assert.ok(rounds >= 2, "expect multiple rounds");

  // child 1: create + start round 1 (random), killed after the 7th label is persisted
  const dbFile = path.join(dir, "killed.db");
  const killed = await runChild(
    dir,
    dbFile,
    [{ op: "create", dataFile, seed: EXP_SEED }, { op: "run", strategy: "random", round: 1 }],
    { afterLabel: { strategy: "random", round: 1, count: 7 } },
    true
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.ok(killed.lines.some((l) => l.startsWith("HOOK ")));

  // after the kill: 7 labels persisted, round still unpublished, public trajectory empty
  const db = new DatabaseSync(dbFile);
  const roundRow = db
    .prepare("SELECT status, labels FROM rounds WHERE strategy = 'random' AND round_no = 1")
    .get() as { status: string; labels: string };
  assert.equal(roundRow.status, "labeling");
  assert.equal(Object.keys(JSON.parse(roundRow.labels)).length, 7);
  db.close();
  const killedExpId = createdId(killed);
  const resumedState = openKernel(dbFile);
  assert.deepEqual(resumedState.readResults(killedExpId).strategies.random, []);
  assert.deepEqual(resumedState.readResults(killedExpId).strategies.uncertainty, []);
  resumedState.close();

  // child 2: resume round 1 and finish everything
  const done = await runChild(
    dir,
    dbFile,
    [...runAllRoundsOps(["random", "uncertainty"], rounds), { op: "read" }],
    undefined,
    false,
    killedExpId
  );
  const actual = resultsOf(done);
  assert.deepEqual(actual.strategies.random, reference.strategies.random);
  assert.deepEqual(actual.strategies.uncertainty, reference.strategies.uncertainty);
});

test("recovery: persisted labels are reused; unqueried truth changes do not alter the batch", async () => {
  const dir = tmpdir();
  const data = makeData();
  const dataFile = writeDataFile(dir, data);
  const truth = new Map(data.pool.map((r) => [r.id, r.label]));

  // reference round-1 selection for the random strategy
  const refKernel = openKernel(path.join(dir, "ref.db"));
  const refExp = refKernel.createExperiment(data, EXP_SEED);
  const refRound1 = refKernel.runRound(refExp, "random", 1);
  refKernel.close();

  const dbFile = path.join(dir, "tamper.db");
  const killed = await runChild(
    dir,
    dbFile,
    [{ op: "create", dataFile, seed: EXP_SEED }, { op: "run", strategy: "random", round: 1 }],
    { afterLabel: { strategy: "random", round: 1, count: 7 } },
    true
  );
  assert.equal(killed.signal, "SIGKILL");

  // tamper with the oracle: flip ALL pool truth labels (queried and unqueried alike)
  const db = new DatabaseSync(dbFile);
  const before = db
    .prepare("SELECT labels FROM rounds WHERE strategy = 'random' AND round_no = 1")
    .get() as { labels: string };
  const fetchedIds = Object.keys(JSON.parse(before.labels)).map(Number);
  assert.equal(fetchedIds.length, 7);
  db.prepare("UPDATE pool_rows SET label = 1 - label WHERE exp_id = (SELECT id FROM experiments)").run();
  db.close();

  // resume and finish round 1
  const done = await runChild(
    dir,
    dbFile,
    [{ op: "run", strategy: "random", round: 1 }, { op: "read" }],
    undefined,
    false,
    createdId(killed)
  );
  const results = resultsOf(done);
  const round1 = results.strategies.random[0] as RoundResult;

  // batch (selection + order) identical to the reference run
  assert.deepEqual(round1.selectedIds, refRound1.selectedIds);

  // the 7 pre-kill labels come from persisted progress (original truth);
  // labels fetched after resume see the tampered oracle
  const db2 = new DatabaseSync(dbFile);
  const after = db2
    .prepare("SELECT labels FROM rounds WHERE strategy = 'random' AND round_no = 1")
    .get() as { labels: string };
  db2.close();
  const labels = JSON.parse(after.labels) as Record<string, number>;
  for (const id of round1.selectedIds) {
    const original = truth.get(id)!;
    const expected = fetchedIds.includes(id) ? original : 1 - original;
    assert.equal(labels[String(id)], expected, `label of row ${id}`);
  }
});

test("recovery: kill after commit but before return; retry returns original result", async () => {
  const dir = tmpdir();
  const data = makeData();
  const dataFile = writeDataFile(dir, data);
  const reference = referenceTrajectory(dir, data);
  const rounds = reference.strategies.uncertainty.length;

  const dbFile = path.join(dir, "commit-kill.db");
  const killed = await runChild(
    dir,
    dbFile,
    [{ op: "create", dataFile, seed: EXP_SEED }, { op: "run", strategy: "uncertainty", round: 1 }],
    { afterCommit: { strategy: "uncertainty", round: 1 } },
    true
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.ok(killed.lines.some((l) => l.startsWith("HOOK ")));
  assert.ok(!killed.lines.some((l) => l.startsWith("RESULT ")), "killed before returning the result");

  // retry the same round: must return the original committed result, then finish everything
  const done = await runChild(
    dir,
    dbFile,
    [{ op: "run", strategy: "uncertainty", round: 1 }, ...runAllRoundsOps(["uncertainty", "random"], rounds), { op: "read" }],
    undefined,
    false,
    createdId(killed)
  );
  // note: runAllRoundsOps re-runs round 1 too; retries must be idempotent
  const retryLine = done.lines.find((l) => l.startsWith("RESULT "));
  assert.ok(retryLine);
  const retryResult = JSON.parse(retryLine.slice("RESULT ".length)) as RoundResult;
  assert.deepEqual(retryResult, reference.strategies.uncertainty[0]);

  const actual = resultsOf(done);
  assert.deepEqual(actual.strategies.uncertainty, reference.strategies.uncertainty);
  assert.deepEqual(actual.strategies.random, reference.strategies.random);
});

test("strategies are independent of execution order", () => {
  const dir = tmpdir();
  const data = makeData();

  const kernelA = openKernel(path.join(dir, "interleaved.db"));
  const expA = kernelA.createExperiment(data, EXP_SEED);
  const exhausted = new Set<Strategy>();
  for (let round = 1; round <= 20; round++) {
    for (const s of STRATEGIES) {
      if (exhausted.has(s)) continue;
      try {
        kernelA.runRound(expA, s, round);
      } catch (err) {
        if (err instanceof Error && err.message === "pool exhausted") exhausted.add(s);
        else throw err;
      }
    }
  }
  const resultsA = kernelA.readResults(expA);
  kernelA.close();

  const kernelB = openKernel(path.join(dir, "sequential.db"));
  const expB = kernelB.createExperiment(data, EXP_SEED);
  runToCompletion(kernelB, expB, "uncertainty");
  runToCompletion(kernelB, expB, "random");
  const resultsB = kernelB.readResults(expB);
  kernelB.close();

  assert.deepEqual(resultsA.strategies, resultsB.strategies);
  // budgets: 32 per full round, seed labels never counted
  for (const s of STRATEGIES) {
    const rounds = resultsA.strategies[s];
    rounds.forEach((r, i) => {
      const expected = i === rounds.length - 1 ? rounds[i].budget : 32 * (i + 1);
      assert.equal(r.budget, expected);
    });
  }
});

test("pool exhaustion, round cap and out-of-order rounds", () => {
  const dir = tmpdir();
  const data = makeData();
  const kernel = openKernel(path.join(dir, "limits.db"));
  const expId = kernel.createExperiment(data, EXP_SEED);
  const results = runToCompletion(kernel, expId, "random");
  assert.equal(results.length, 4); // 100 pool rows -> 32+32+32+4
  assert.equal(results[3].selectedIds.length, 4);
  assert.equal(results[3].budget, 100);
  assert.throws(() => kernel.runRound(expId, "random", 5), /pool exhausted/);
  assert.throws(() => kernel.runRound(expId, "random", 21), /max rounds/);
  assert.throws(() => kernel.runRound(expId, "uncertainty", 3), /out of order/);
  // retry of a committed round returns the original result
  assert.deepEqual(kernel.runRound(expId, "random", 2), results[1]);
  kernel.close();
});

test("createExperiment validates the dataset", () => {
  const dir = tmpdir();
  const kernel = openKernel(path.join(dir, "validate.db"));
  const data = makeData();
  const dup = makeData();
  dup.pool[0] = { ...dup.pool[0], id: data.seed[0].id };
  assert.throws(() => kernel.createExperiment(dup, EXP_SEED), /duplicate row id/);
  const oneClass = makeData();
  oneClass.seed = oneClass.seed.map((r) => ({ ...r, label: 0 as 0 | 1 }));
  assert.throws(() => kernel.createExperiment(oneClass, EXP_SEED), /both classes/);
  kernel.close();
});

test("dataset is deterministic across regenerations", () => {
  assert.deepEqual(makeData(), makeData(DATA_SEED));
});

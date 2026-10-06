import * as fs from "node:fs";
import { openKernel, __testHooks } from "../src/kernel";
import { ExperimentData, Strategy } from "../src/types";

interface HookSpec {
  afterLabel?: { strategy?: Strategy; round: number; count: number };
  afterCommit?: { strategy?: Strategy; round: number };
}

function emit(line: string): void {
  fs.writeSync(1, line + "\n");
}

function blockForKill(): void {
  // park the process so the parent can SIGKILL it at a deterministic point
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, 60000);
}

function installHooks(): void {
  const raw = process.env.AL_HOOK;
  if (!raw) return;
  const spec = JSON.parse(raw) as HookSpec;
  if (spec.afterLabel) {
    const want = spec.afterLabel;
    __testHooks.afterLabelPersisted = (info) => {
      if (info.round !== want.round) return;
      if (want.strategy && info.strategy !== want.strategy) return;
      if (info.count !== want.count) return;
      emit(`HOOK ${JSON.stringify({ point: "afterLabel", ...info })}`);
      blockForKill();
    };
  }
  if (spec.afterCommit) {
    const want = spec.afterCommit;
    __testHooks.afterCommit = (info) => {
      if (info.round !== want.round) return;
      if (want.strategy && info.strategy !== want.strategy) return;
      emit(`HOOK ${JSON.stringify({ point: "afterCommit", ...info })}`);
      blockForKill();
    };
  }
}

type Op =
  | { op: "create"; dataFile: string; seed: number }
  | { op: "run"; strategy: Strategy; round: number }
  | { op: "read" };

function main(): void {
  const [dbPath, opsFile] = process.argv.slice(2);
  if (!dbPath || !opsFile) {
    emit("ERROR usage: child.js <dbPath> <opsFile>");
    process.exit(1);
  }
  installHooks();
  const ops = JSON.parse(fs.readFileSync(opsFile, "utf8")) as Op[];
  const kernel = openKernel(dbPath);
  let experimentId = process.env.AL_EXP_ID ?? "";
  try {
    for (const op of ops) {
      if (op.op === "create") {
        const data = JSON.parse(fs.readFileSync(op.dataFile, "utf8")) as ExperimentData;
        experimentId = kernel.createExperiment(data, op.seed);
        emit(`CREATED ${experimentId}`);
      } else if (op.op === "run") {
        const result = kernel.runRound(experimentId, op.strategy, op.round);
        emit(`RESULT ${JSON.stringify(result)}`);
      } else {
        emit(`RESULTS ${JSON.stringify(kernel.readResults(experimentId))}`);
      }
    }
  } catch (err) {
    emit(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    kernel.close();
  }
}

main();

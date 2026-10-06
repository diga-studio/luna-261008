import * as fs from "node:fs";
import { ExperimentKernel, type Strategy } from "../../src/index.js";
import { makeData } from "../helpers.js";

const [, , mode, ...args] = process.argv;

function spin(): never {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(sab, 0, 0, 1000);
}

function markAndSpin(markerFile: string): void {
  fs.writeFileSync(markerFile, "ready");
  spin();
}

function runAll(kernel: ExperimentKernel, experimentId: string): void {
  for (const strategy of ["uncertainty", "random"] as Strategy[]) {
    for (let roundNo = 1; roundNo <= 20; roundNo++) {
      if (kernel.runRound(experimentId, strategy, roundNo) === null) break;
    }
  }
}

const data = makeData({ genSeed: 42 });
const seed = 12345;

if (mode === "baseline") {
  const [dbPath, resultsFile] = args;
  const kernel = new ExperimentKernel({ dbPath });
  const id = kernel.createExperiment(data, seed);
  runAll(kernel, id);
  fs.writeFileSync(resultsFile, JSON.stringify(kernel.readResults(id)));
  kernel.close();
} else if (mode === "crash-labels") {
  const [dbPath, idFile, markerFile, strategy, roundNoStr, nStr] = args;
  const roundNo = Number(roundNoStr);
  const n = Number(nStr);
  let target = false;
  const kernel = new ExperimentKernel({
    dbPath,
    afterLabelPersisted: (count) => {
      if (target && count === n) markAndSpin(markerFile);
    },
  });
  const id = kernel.createExperiment(data, seed);
  fs.writeFileSync(idFile, id);
  for (let r = 1; r < roundNo; r++) kernel.runRound(id, strategy as Strategy, r);
  target = true;
  kernel.runRound(id, strategy as Strategy, roundNo);
  kernel.close();
} else if (mode === "crash-return") {
  const [dbPath, idFile, markerFile, strategy, roundNoStr] = args;
  const roundNo = Number(roundNoStr);
  let target = false;
  const kernel = new ExperimentKernel({
    dbPath,
    beforeRunRoundReturn: () => {
      if (target) markAndSpin(markerFile);
    },
  });
  const id = kernel.createExperiment(data, seed);
  fs.writeFileSync(idFile, id);
  for (let r = 1; r < roundNo; r++) kernel.runRound(id, strategy as Strategy, r);
  target = true;
  kernel.runRound(id, strategy as Strategy, roundNo);
  kernel.close();
} else if (mode === "resume") {
  const [dbPath, idFile, resultsFile] = args;
  const id = fs.readFileSync(idFile, "utf8");
  const kernel = new ExperimentKernel({ dbPath });
  runAll(kernel, id);
  fs.writeFileSync(resultsFile, JSON.stringify(kernel.readResults(id)));
  kernel.close();
} else if (mode === "run-one") {
  const [dbPath, idFile, strategy, roundNoStr, outFile] = args;
  const id = fs.readFileSync(idFile, "utf8");
  const kernel = new ExperimentKernel({ dbPath });
  const result = kernel.runRound(id, strategy as Strategy, Number(roundNoStr));
  fs.writeFileSync(outFile, JSON.stringify(result));
  kernel.close();
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

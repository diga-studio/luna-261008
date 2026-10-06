import { tests as chunkingTests } from "./chunking.test";
import { tests as boundaryTests } from "./boundaries.test";
import { tests as streamingTests } from "./streaming.test";
import { tests as limitTests } from "./limits.test";

const suites: Array<[string, Array<[string, () => void]>]> = [
  ["chunking", chunkingTests],
  ["boundaries", boundaryTests],
  ["streaming", streamingTests],
  ["limits", limitTests],
];

let passed = 0;
let failed = 0;
for (const [, tests] of suites) {
  for (const [name, fn] of tests) {
    try {
      fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL - ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}

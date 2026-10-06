"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chunking_test_1 = require("./chunking.test");
const boundaries_test_1 = require("./boundaries.test");
const streaming_test_1 = require("./streaming.test");
const limits_test_1 = require("./limits.test");
const suites = [
    ["chunking", chunking_test_1.tests],
    ["boundaries", boundaries_test_1.tests],
    ["streaming", streaming_test_1.tests],
    ["limits", limits_test_1.tests],
];
let passed = 0;
let failed = 0;
for (const [, tests] of suites) {
    for (const [name, fn] of tests) {
        try {
            fn();
            passed++;
            console.log(`ok - ${name}`);
        }
        catch (error) {
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

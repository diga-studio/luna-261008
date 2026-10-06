import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompliance, suggestRepair } from "../src/index.js";

test("模块导出两个核心能力", () => {
  assert.equal(typeof checkCompliance, "function");
  assert.equal(typeof suggestRepair, "function");
});

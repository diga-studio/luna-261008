import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProcessDefinition } from "../dist/index.js";

describe("skeleton", () => {
  it("types are usable", () => {
    const def: ProcessDefinition = { steps: [] };
    assert.equal(def.steps.length, 0);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { AudienceNexus } from "../src/index.js";
import type { ProfileRecord, Rule } from "../src/types.js";
import { ReferenceNexus } from "./reference.js";

const sharedScore: Rule = { type: "SCORE", min: 20, max: 80 };
const sharedRegion: Rule = { type: "REGION", region: "BJ" };

const ruleA: Rule = {
  type: "AND",
  children: [
    sharedScore,
    { type: "OR", children: [sharedRegion, { type: "TAG", tag: "vip" }] },
  ],
};

const ruleB: Rule = {
  type: "AND",
  children: [
    sharedScore,
    { type: "OR", children: [sharedRegion, { type: "TAG", tag: "premium" }] },
  ],
};

test("shared partial rules: batch moves users into, out of, and within intersection", () => {
  const nexus = new AudienceNexus();
  const reference = new ReferenceNexus();

  const apply = (batch: ProfileRecord[]) => {
    nexus.upsertBatch(batch);
    reference.upsertBatch(batch);
  };
  const verify = (label: string) => {
    const stats = nexus.stats("A", "B");
    assert.strictEqual(stats.count, reference.count("A"), `${label}: count(A)`);
    assert.strictEqual(stats.otherCount, reference.count("B"), `${label}: count(B)`);
    assert.strictEqual(stats.intersection, reference.intersection("A", "B"), `${label}: A x B`);
  };

  apply([
    { userId: "u-stay", engagementScore: 50, region: "BJ", purchaseTags: [] },
    { userId: "u-enter", engagementScore: 10, region: "BJ", purchaseTags: [] },
    { userId: "u-exit", engagementScore: 50, region: "BJ", purchaseTags: [] },
    { userId: "u-only-a", engagementScore: 50, region: "SH", purchaseTags: ["vip"] },
    { userId: "u-b-to-a", engagementScore: 50, region: "SH", purchaseTags: ["premium"] },
    { userId: "u-outsider", engagementScore: 5, region: "GZ", purchaseTags: [] },
  ]);
  nexus.saveSegment("A", ruleA);
  reference.saveSegment("A", ruleA);
  nexus.saveSegment("B", ruleB);
  reference.saveSegment("B", ruleB);

  verify("initial");
  assert.strictEqual(nexus.stats("A").count, 3);
  assert.strictEqual(nexus.stats("B").count, 3);
  assert.strictEqual(nexus.stats("A", "B").intersection, 2);

  apply([
    { userId: "u-stay", engagementScore: 60, region: "BJ", purchaseTags: ["vip", "premium"] },
    { userId: "u-enter", engagementScore: 50, region: "BJ", purchaseTags: [] },
    { userId: "u-exit", engagementScore: 90, region: "BJ", purchaseTags: [] },
    { userId: "u-b-to-a", engagementScore: 50, region: "SH", purchaseTags: ["vip"] },
  ]);
  verify("after batch");
  assert.strictEqual(nexus.stats("A").count, 4);
  assert.strictEqual(nexus.stats("B").count, 2);
  assert.strictEqual(nexus.stats("A", "B").intersection, 2);

  apply([{ userId: "u-stay", engagementScore: 60, region: "BJ", purchaseTags: [] }]);
  verify("after tag strip");
  assert.strictEqual(nexus.stats("A", "B").intersection, 2);

  apply([{ userId: "u-enter", engagementScore: 50, region: null, purchaseTags: [] }]);
  verify("after region null");
  assert.strictEqual(nexus.stats("A", "B").intersection, 1);

  nexus.saveSegment("B", {
    type: "AND",
    children: [sharedScore, { type: "OR", children: [sharedRegion, { type: "TAG", tag: "vip" }] }],
  });
  reference.saveSegment("B", {
    type: "AND",
    children: [sharedScore, { type: "OR", children: [sharedRegion, { type: "TAG", tag: "vip" }] }],
  });
  verify("after B redefined to equal A");
  assert.strictEqual(nexus.stats("A", "B").intersection, nexus.stats("A").count);
});

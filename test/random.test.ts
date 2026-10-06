import assert from "node:assert/strict";
import test from "node:test";
import { AudienceNexus } from "../src/index.js";
import type { ProfileRecord, Rule } from "../src/types.js";
import { ReferenceNexus } from "./reference.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  pick<T>(items: ReadonlyArray<T>): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("empty pool");
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

const REGIONS = ["BJ", "SH", "GZ", "SZ", "HZ", "CD", "WH", "NJ"];
const TAGS = ["books", "games", "music", "sports", "food", "travel", "tech", "fashion", "pets", "art", "cars", "home"];
const SEGMENT_IDS = Array.from({ length: 24 }, (_, i) => `seg-${i}`);

function randomScoreLeaf(rng: Random): Rule {
  let min = rng.int(101);
  let max = rng.int(101);
  if (rng.chance(0.2)) min = 0;
  if (rng.chance(0.2)) max = 100;
  if (min > max) [min, max] = [max, min];
  return { type: "SCORE", min, max };
}

function randomLeaf(rng: Random): Rule {
  switch (rng.int(3)) {
    case 0:
      return randomScoreLeaf(rng);
    case 1:
      return { type: "REGION", region: rng.pick(REGIONS) };
    default:
      return { type: "TAG", tag: rng.pick(TAGS) };
  }
}

function randomRule(rng: Random, depth: number, budget: { leaves: number }): Rule {
  const mustBeLeaf = depth >= 3 || budget.leaves <= 1;
  if (mustBeLeaf || rng.chance(0.35)) {
    budget.leaves -= 1;
    return randomLeaf(rng);
  }
  const childCount = 1 + rng.int(3);
  const children: Rule[] = [];
  for (let i = 0; i < childCount && budget.leaves > 0; i++) {
    children.push(randomRule(rng, depth + 1, budget));
  }
  if (children.length > 1 && rng.chance(0.25)) {
    const duplicate = children[rng.int(children.length)];
    if (duplicate !== undefined) children.push(duplicate);
  }
  return { type: rng.chance(0.5) ? "AND" : "OR", children };
}

function randomRecord(rng: Random, userPool: string[]): ProfileRecord {
  const userId = rng.pick(userPool);
  let engagementScore: number | null;
  const roll = rng.int(10);
  if (roll < 2) engagementScore = null;
  else if (roll < 3) engagementScore = 0;
  else if (roll < 4) engagementScore = 100;
  else engagementScore = rng.int(101);
  const region = rng.chance(0.2) ? null : rng.pick(REGIONS);
  const tagCount = rng.int(9);
  const purchaseTags: string[] = [];
  for (let i = 0; i < tagCount; i++) {
    const tag = rng.pick(TAGS);
    if (!purchaseTags.includes(tag)) purchaseTags.push(tag);
  }
  return { userId, engagementScore, region, purchaseTags };
}

function verifyAll(nexus: AudienceNexus, reference: ReferenceNexus, savedSegments: string[], rng: Random): void {
  for (const segmentId of savedSegments) {
    const actual = nexus.stats(segmentId);
    assert.strictEqual(actual.count, reference.count(segmentId), `count mismatch for ${segmentId}`);
  }
  const pairs = Math.min(6, savedSegments.length * 2);
  for (let i = 0; i < pairs; i++) {
    const a = rng.pick(savedSegments);
    const b = rng.pick(savedSegments);
    const stats = nexus.stats(a, b);
    assert.strictEqual(stats.count, reference.count(a), `pair count mismatch for ${a}`);
    assert.strictEqual(stats.otherCount, reference.count(b), `pair otherCount mismatch for ${b}`);
    assert.strictEqual(
      stats.intersection,
      reference.intersection(a, b),
      `intersection mismatch for ${a} x ${b}`,
    );
  }
}

test("randomized rules and updates match reference evaluator", { timeout: 60000 }, () => {
  for (const seed of [11, 22, 33]) {
    const rng = new Random(seed);
    const nexus = new AudienceNexus();
    const reference = new ReferenceNexus();
    const savedSegments: string[] = [];
    const userPool = Array.from({ length: 150 }, (_, i) => `user-${i}`);

    for (let round = 0; round < 80; round++) {
      const op = rng.int(10);
      if (op < 5 || savedSegments.length === 0) {
        const batchSize = 1 + rng.int(9);
        const batch: ProfileRecord[] = [];
        for (let i = 0; i < batchSize; i++) {
          batch.push(randomRecord(rng, userPool));
        }
        if (batch.length >= 2 && rng.chance(0.4)) {
          const first = batch[0];
          if (first !== undefined) {
            batch.push({ ...first, purchaseTags: [] });
          }
        }
        nexus.upsertBatch(batch);
        reference.upsertBatch(batch);
      } else if (op < 8) {
        const segmentId = rng.pick(SEGMENT_IDS);
        const rule = randomRule(rng, 1, { leaves: 16 });
        nexus.saveSegment(segmentId, rule);
        reference.saveSegment(segmentId, rule);
        if (!savedSegments.includes(segmentId)) savedSegments.push(segmentId);
      } else {
        const segmentId = rng.pick(savedSegments);
        const rule = randomRule(rng, 1, { leaves: 16 });
        nexus.saveSegment(segmentId, rule);
        reference.saveSegment(segmentId, rule);
      }
      verifyAll(nexus, reference, savedSegments, rng);
    }
  }
});

test("deterministic edge cases: boundaries, nulls, tag removal, duplicate branches", () => {
  const nexus = new AudienceNexus();
  const reference = new ReferenceNexus();
  const apply = (batch: ProfileRecord[]) => {
    nexus.upsertBatch(batch);
    reference.upsertBatch(batch);
  };
  const define = (id: string, rule: Rule) => {
    nexus.saveSegment(id, rule);
    reference.saveSegment(id, rule);
  };
  const check = (id: string) => {
    assert.strictEqual(nexus.stats(id).count, reference.count(id), `count mismatch for ${id}`);
  };
  const checkPair = (a: string, b: string) => {
    const stats = nexus.stats(a, b);
    assert.strictEqual(stats.intersection, reference.intersection(a, b), `intersection ${a} x ${b}`);
    assert.strictEqual(stats.count, reference.count(a));
    assert.strictEqual(stats.otherCount, reference.count(b));
  };

  apply([
    { userId: "edge-0", engagementScore: 0, region: null, purchaseTags: ["x"] },
    { userId: "edge-100", engagementScore: 100, region: "BJ", purchaseTags: [] },
    { userId: "edge-null", engagementScore: null, region: "BJ", purchaseTags: ["x", "y"] },
  ]);

  define("boundaries", {
    type: "OR",
    children: [
      { type: "SCORE", min: 0, max: 0 },
      { type: "SCORE", min: 100, max: 100 },
      { type: "SCORE", min: 0, max: 100 },
    ],
  });
  check("boundaries");

  define("dup-or", {
    type: "OR",
    children: [
      { type: "TAG", tag: "x" },
      { type: "TAG", tag: "x" },
      { type: "AND", children: [{ type: "REGION", region: "BJ" }, { type: "REGION", region: "BJ" }] },
    ],
  });
  check("dup-or");
  checkPair("boundaries", "dup-or");
  checkPair("dup-or", "dup-or");

  apply([
    { userId: "edge-0", engagementScore: 0, region: null, purchaseTags: [] },
    { userId: "edge-100", engagementScore: null, region: null, purchaseTags: ["x"] },
    { userId: "edge-null", engagementScore: 50, region: null, purchaseTags: [] },
  ]);
  check("boundaries");
  check("dup-or");
  checkPair("boundaries", "dup-or");

  define("boundaries", { type: "AND", children: [{ type: "TAG", tag: "y" }] });
  check("boundaries");
  check("dup-or");
  checkPair("boundaries", "dup-or");
});

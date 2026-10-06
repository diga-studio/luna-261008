import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TalentRecommender,
  PROFESSION_TAGS,
} from "../src/index";
import type {
  MatchRules,
  ProfessionTag,
  Project,
  Talent,
} from "../src/index";

// ---------------------------------------------------------------------------
// Independent reference implementation: scores every talent from scratch with
// exact integer arithmetic and returns the fully sorted id list.
// ---------------------------------------------------------------------------

function referenceScores(
  talents: readonly Talent[],
  project: Project,
  rules: MatchRules,
): Array<{ id: number; total: bigint }> {
  const results: Array<{ id: number; total: bigint }> = [];
  for (const talent of talents) {
    if (project.blockList.has(talent.id)) continue;
    let common = 0;
    for (const tag of talent.tags) {
      if (project.tags.has(tag)) common += 1;
    }
    if (common === 0) continue;
    if (!project.allowList.has(talent.id) && talent.quality < rules.minQuality) {
      continue;
    }
    const union = talent.tags.size + project.tags.size - common;
    const tagPart = (BigInt(common) * 10000n) / BigInt(union);
    const qualityPart = (BigInt(talent.quality) * 10000n) / 500n;
    const rate = BigInt(talent.hourlyRate);
    const fitA = 10000n;
    const fitB = (rate * 10000n) / BigInt(project.budgetMin);
    const fitC = (BigInt(project.budgetMax) * 10000n) / rate;
    const budgetPart = fitA < fitB ? (fitA < fitC ? fitA : fitC) : fitB < fitC ? fitB : fitC;
    const availabilityPart = talent.available ? 10000n : 0n;
    const experiencePart =
      (BigInt(Math.min(talent.experienceYears, 20)) * 10000n) / 20n;
    const total =
      tagPart * BigInt(rules.weightTagMatch) +
      qualityPart * BigInt(rules.weightQuality) +
      budgetPart * BigInt(rules.weightBudgetFit) +
      availabilityPart * BigInt(rules.weightAvailability) +
      experiencePart * BigInt(rules.weightExperience);
    results.push({ id: talent.id, total });
  }
  results.sort((a, b) => {
    if (a.total !== b.total) return a.total > b.total ? -1 : 1;
    return a.id - b.id;
  });
  return results;
}

function referenceRecommend(
  talents: readonly Talent[],
  project: Project,
  rules: MatchRules,
): number[] {
  return referenceScores(talents, project, rules)
    .slice(0, 20)
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTalent(overrides: Partial<Talent> & { id: number }): Talent {
  return {
    tags: new Set<ProfessionTag>(["illustrator"]),
    quality: 250,
    hourlyRate: 5000,
    available: true,
    experienceYears: 10,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    tags: new Set<ProfessionTag>(["illustrator"]),
    budgetMin: 1000,
    budgetMax: 10000,
    allowList: new Set<number>(),
    blockList: new Set<number>(),
    ...overrides,
  };
}

function makeRules(overrides: Partial<MatchRules> = {}): MatchRules {
  return {
    weightTagMatch: 20,
    weightQuality: 20,
    weightBudgetFit: 20,
    weightAvailability: 20,
    weightExperience: 20,
    minQuality: 0,
    ...overrides,
  };
}

/** Deterministic PRNG (LCG) so randomized tests are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomTalent(id: number, rand: () => number): Talent {
  const tagCount = 1 + Math.floor(rand() * PROFESSION_TAGS.length);
  const shuffled = [...PROFESSION_TAGS].sort(() => rand() - 0.5);
  return {
    id,
    tags: new Set(shuffled.slice(0, tagCount)),
    quality: Math.floor(rand() * 501),
    hourlyRate: 1 + Math.floor(rand() * 100000),
    available: rand() < 0.7,
    experienceYears: Math.floor(rand() * 41),
  };
}

function randomRules(rand: () => number): MatchRules {
  const cuts = [0, 100];
  for (let i = 0; i < 4; i += 1) cuts.push(Math.floor(rand() * 101));
  cuts.sort((a, b) => a - b);
  const weights = [];
  for (let i = 0; i < 5; i += 1) weights.push(cuts[i + 1] - cuts[i]);
  return {
    weightTagMatch: weights[0],
    weightQuality: weights[1],
    weightBudgetFit: weights[2],
    weightAvailability: weights[3],
    weightExperience: weights[4],
    minQuality: Math.floor(rand() * 501),
  };
}

function randomProject(rand: () => number, poolSize: number): Project {
  const tagCount = 1 + Math.floor(rand() * PROFESSION_TAGS.length);
  const shuffled = [...PROFESSION_TAGS].sort(() => rand() - 0.5);
  const budgetMin = 1 + Math.floor(rand() * 100000);
  const budgetMax = budgetMin + Math.floor(rand() * (100001 - budgetMin));
  const allowList = new Set<number>();
  const blockList = new Set<number>();
  for (let id = 1; id <= poolSize; id += 1) {
    const roll = rand();
    if (roll < 0.05) allowList.add(id);
    if (roll >= 0.05 && roll < 0.1) blockList.add(id);
    if (roll >= 0.1 && roll < 0.13) {
      allowList.add(id);
      blockList.add(id);
    }
  }
  return {
    tags: new Set(shuffled.slice(0, tagCount)),
    budgetMin,
    budgetMax,
    allowList,
    blockList,
  };
}

// ---------------------------------------------------------------------------
// Consistency with the independent full scoring + sorting reference
// ---------------------------------------------------------------------------

test("recommend matches independent full scoring for randomized pools", () => {
  for (const seed of [1, 7, 42, 2024, 987654]) {
    const rand = makeRandom(seed);
    const talents = Array.from({ length: 120 }, (_, i) =>
      randomTalent(i + 1, rand),
    );
    const rules = randomRules(rand);
    const project = randomProject(rand, talents.length);
    const engine = new TalentRecommender();
    engine.loadTalents(talents);
    engine.setRules(rules);
    assert.deepEqual(
      engine.recommend(project),
      referenceRecommend(talents, project, rules),
      `seed ${seed}`,
    );
  }
});

test("recommend returns every eligible talent when fewer than 20 qualify", () => {
  const talents = [
    makeTalent({ id: 5, tags: new Set(["animator"]) }),
    makeTalent({ id: 2 }),
    makeTalent({ id: 9, tags: new Set(["ux-designer"]) }),
  ];
  const engine = new TalentRecommender();
  engine.loadTalents(talents);
  const project = makeProject({ tags: new Set(["illustrator", "animator"]) });
  assert.deepEqual(
    engine.recommend(project),
    referenceRecommend(talents, project, makeRules()),
  );
  assert.equal(engine.recommend(project).length, 2);
});

// ---------------------------------------------------------------------------
// Ranking reversal driven by weight and budget changes
// ---------------------------------------------------------------------------

test("weight change reverses the ranking", () => {
  const premium = makeTalent({ id: 1, quality: 500, hourlyRate: 90000 });
  const cheap = makeTalent({ id: 2, quality: 100, hourlyRate: 1000 });
  const engine = new TalentRecommender();
  engine.loadTalents([premium, cheap]);
  const project = makeProject({ budgetMin: 1000, budgetMax: 5000 });

  engine.setRules(
    makeRules({
      weightTagMatch: 0,
      weightQuality: 100,
      weightBudgetFit: 0,
      weightAvailability: 0,
      weightExperience: 0,
    }),
  );
  assert.deepEqual(engine.recommend(project), [1, 2]);

  engine.setRules(
    makeRules({
      weightTagMatch: 0,
      weightQuality: 0,
      weightBudgetFit: 100,
      weightAvailability: 0,
      weightExperience: 0,
    }),
  );
  assert.deepEqual(engine.recommend(project), [2, 1]);
});

test("budget change reverses the ranking", () => {
  const premium = makeTalent({ id: 1, quality: 500, hourlyRate: 90000 });
  const cheap = makeTalent({ id: 2, quality: 100, hourlyRate: 1000 });
  const engine = new TalentRecommender();
  engine.loadTalents([premium, cheap]);
  engine.setRules(
    makeRules({
      weightTagMatch: 0,
      weightQuality: 0,
      weightBudgetFit: 100,
      weightAvailability: 0,
      weightExperience: 0,
    }),
  );

  const tightBudget = makeProject({ budgetMin: 1000, budgetMax: 5000 });
  assert.deepEqual(engine.recommend(tightBudget), [2, 1]);

  const richBudget = makeProject({ budgetMin: 90000, budgetMax: 100000 });
  assert.deepEqual(engine.recommend(richBudget), [1, 2]);
});

// ---------------------------------------------------------------------------
// Tied talents entering / leaving the top 20 after a profile update
// ---------------------------------------------------------------------------

test("tied talents enter and leave the top 20 after updates", () => {
  const talents = Array.from({ length: 25 }, (_, i) =>
    makeTalent({ id: i + 1, tags: new Set(["animator"]) }),
  );
  const engine = new TalentRecommender();
  engine.loadTalents(talents);
  const project = makeProject({ tags: new Set(["animator"]) });

  // All 25 tie; the 20 lowest ids win the tie-break.
  assert.deepEqual(
    engine.recommend(project),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );

  // Talent 25 improves and jumps to the front, pushing talent 20 out.
  engine.replaceTalent(
    makeTalent({ id: 25, tags: new Set(["animator"]), quality: 500 }),
  );
  assert.deepEqual(engine.recommend(project), [
    25,
    ...Array.from({ length: 19 }, (_, i) => i + 1),
  ]);

  // Talent 1 worsens and drops out; talent 20 comes back in.
  engine.replaceTalent(
    makeTalent({ id: 1, tags: new Set(["animator"]), quality: 0 }),
  );
  assert.deepEqual(engine.recommend(project), [
    25,
    ...Array.from({ length: 19 }, (_, i) => i + 2),
  ]);

  // A full reload restores the original ordering.
  engine.loadTalents(talents);
  assert.deepEqual(
    engine.recommend(project),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
});

// ---------------------------------------------------------------------------
// Eligibility rules
// ---------------------------------------------------------------------------

test("block list beats allow list and quality threshold", () => {
  const talent = makeTalent({ id: 1, quality: 0 });
  const engine = new TalentRecommender();
  engine.loadTalents([talent]);
  engine.setRules(makeRules({ minQuality: 500 }));

  // Allow list exempts the quality threshold.
  const allowed = makeProject({ allowList: new Set([1]) });
  assert.deepEqual(engine.recommend(allowed), [1]);

  // Block list excludes unconditionally, even when also allowed.
  const blocked = makeProject({
    allowList: new Set([1]),
    blockList: new Set([1]),
  });
  assert.deepEqual(engine.recommend(blocked), []);

  // Without the allow list the quality threshold filters the talent out.
  assert.deepEqual(engine.recommend(makeProject()), []);
});

test("talent must share at least one profession tag with the project", () => {
  const talents = [
    makeTalent({ id: 1, tags: new Set(["photographer"]) }),
    makeTalent({ id: 2, tags: new Set(["illustrator", "photographer"]) }),
  ];
  const engine = new TalentRecommender();
  engine.loadTalents(talents);
  const project = makeProject({ tags: new Set(["ux-designer", "photographer"]) });
  assert.deepEqual(
    engine.recommend(project),
    referenceRecommend(talents, project, makeRules()),
  );
  const noMatch = makeProject({ tags: new Set(["ux-designer"]) });
  assert.deepEqual(engine.recommend(noMatch), []);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("invalid talent profiles are rejected", () => {
  const engine = new TalentRecommender();
  assert.throws(() => engine.loadTalents([makeTalent({ id: 0 })]));
  assert.throws(() => engine.loadTalents([makeTalent({ id: 1, quality: 501 })]));
  assert.throws(() =>
    engine.loadTalents([makeTalent({ id: 1, hourlyRate: 0 })]),
  );
  assert.throws(() =>
    engine.loadTalents([makeTalent({ id: 1, experienceYears: 41 })]),
  );
  assert.throws(() =>
    engine.loadTalents([makeTalent({ id: 1, tags: new Set() })]),
  );
  assert.throws(() =>
    engine.loadTalents([
      makeTalent({ id: 1, tags: new Set(["plumber" as ProfessionTag]) }),
    ]),
  );
  assert.throws(() =>
    engine.loadTalents([makeTalent({ id: 1 }), makeTalent({ id: 1 })]),
  );
});

test("invalid rules and projects are rejected", () => {
  const engine = new TalentRecommender();
  engine.loadTalents([makeTalent({ id: 1 })]);
  assert.throws(() => engine.setRules(makeRules({ weightQuality: 21 })));
  assert.throws(() => engine.setRules(makeRules({ minQuality: 501 })));
  assert.throws(() =>
    engine.recommend(makeProject({ budgetMin: 5000, budgetMax: 4000 })),
  );
  assert.throws(() => engine.recommend(makeProject({ tags: new Set() })));
  assert.throws(() => engine.replaceTalent(makeTalent({ id: 99 })));
});

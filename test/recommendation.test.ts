import assert from "node:assert/strict";
import test from "node:test";
import { CraftBridge } from "../src/index.js";
import type {
  MatchingRules,
  ProfessionTag,
  Project,
  Recommendation,
  Talent,
} from "../src/index.js";

const ALL_TAGS: readonly ProfessionTag[] = [
  "illustrator",
  "animator",
  "videographer",
  "ux-designer",
];

/* ---------- 独立参考实现：直接按需求规格逐人评分排序（BigInt 精确运算） ---------- */

function refFloorScaled(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 10000n) / denominator;
}

function refScore(talent: Talent, project: Project, rules: MatchingRules): number {
  let inter = 0n;
  for (const tag of talent.tags) if (project.tags.has(tag)) inter += 1n;
  const union = BigInt(talent.tags.size + project.tags.size) - inter;
  const tag = (inter * 10000n) / union;
  const quality = refFloorScaled(BigInt(talent.quality), 500n);
  const budget = [10000n,
    refFloorScaled(BigInt(talent.hourlyRate), BigInt(project.budgetMin)),
    refFloorScaled(BigInt(project.budgetMax), BigInt(talent.hourlyRate)),
  ].reduce((a, b) => (a < b ? a : b));
  const avail = talent.available ? 10000n : 0n;
  const exp = refFloorScaled(BigInt(Math.min(talent.experienceYears, 20)), 20n);
  const w = rules.weights;
  const total =
    tag * BigInt(w.tagMatch) +
    quality * BigInt(w.quality) +
    budget * BigInt(w.budget) +
    avail * BigInt(w.availability) +
    exp * BigInt(w.experience);
  return Number(total);
}

function refRecommend(
  talents: readonly Talent[],
  project: Project,
  rules: MatchingRules,
): Recommendation[] {
  return talents
    .filter((t) => {
      if (project.denylist.has(t.id)) return false;
      const shares = [...t.tags].some((tag) => project.tags.has(tag));
      if (!shares) return false;
      return t.quality >= rules.minQuality || project.allowlist.has(t.id);
    })
    .map((t) => ({ talentId: t.id, totalScore: refScore(t, project, rules) }))
    .sort((a, b) => b.totalScore - a.totalScore || a.talentId - b.talentId)
    .slice(0, 20);
}

/* ---------- 测试数据工具 ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTalent(rand: () => number, id: number): Talent {
  const tagCount = 1 + Math.floor(rand() * ALL_TAGS.length);
  const shuffled = [...ALL_TAGS].sort(() => rand() - 0.5);
  return {
    id,
    tags: new Set(shuffled.slice(0, tagCount)),
    quality: Math.floor(rand() * 501),
    hourlyRate: 1 + Math.floor(rand() * 100000),
    available: rand() < 0.5,
    experienceYears: Math.floor(rand() * 41),
  };
}

function randomRules(rand: () => number): MatchingRules {
  const cuts = [0, 0, 0, 0].map(() => Math.floor(rand() * 101));
  cuts.sort((a, b) => a - b);
  const parts = [cuts[0], cuts[1] - cuts[0], cuts[2] - cuts[1], cuts[3] - cuts[2], 100 - cuts[3]];
  return {
    weights: {
      tagMatch: parts[0],
      quality: parts[1],
      budget: parts[2],
      availability: parts[3],
      experience: parts[4],
    },
    minQuality: Math.floor(rand() * 501),
  };
}

function randomProject(rand: () => number, ids: number[]): Project {
  const tagCount = 1 + Math.floor(rand() * ALL_TAGS.length);
  const shuffled = [...ALL_TAGS].sort(() => rand() - 0.5);
  const lo = 1 + Math.floor(rand() * 100000);
  const hi = lo + Math.floor(rand() * (100001 - lo));
  const pick = (n: number) =>
    new Set([...ids].sort(() => rand() - 0.5).slice(0, n));
  return {
    tags: new Set(shuffled.slice(0, tagCount)),
    budgetMin: lo,
    budgetMax: hi,
    allowlist: pick(Math.floor(rand() * 5)),
    denylist: pick(Math.floor(rand() * 5)),
  };
}

/* ---------- 场景测试 ---------- */

test("权重与预算变化导致排名反转", () => {
  const senior: Talent = {
    id: 1,
    tags: new Set<ProfessionTag>(["illustrator"]),
    quality: 500,
    hourlyRate: 90000,
    available: true,
    experienceYears: 35,
  };
  const junior: Talent = {
    id: 2,
    tags: new Set<ProfessionTag>(["illustrator"]),
    quality: 100,
    hourlyRate: 5000,
    available: false,
    experienceYears: 1,
  };
  const bridge = new CraftBridge();
  bridge.loadTalents([senior, junior]);

  const qualityFirst: MatchingRules = {
    weights: { tagMatch: 0, quality: 100, budget: 0, availability: 0, experience: 0 },
    minQuality: 0,
  };
  const budgetFirst: MatchingRules = {
    weights: { tagMatch: 0, quality: 0, budget: 100, availability: 0, experience: 0 },
    minQuality: 0,
  };
  const project: Project = {
    tags: new Set<ProfessionTag>(["illustrator"]),
    budgetMin: 4000,
    budgetMax: 20000,
    allowlist: new Set(),
    denylist: new Set(),
  };

  bridge.updateRules(qualityFirst);
  assert.deepEqual(
    bridge.recommend(project).map((r) => r.talentId),
    [1, 2],
  );

  bridge.updateRules(budgetFirst);
  assert.deepEqual(
    bridge.recommend(project).map((r) => r.talentId),
    [2, 1],
  );

  // 预算窗口变化再次反转：窗口上移后资深者落入预算内，初级者时薪低于下限。
  const highBudget: Project = { ...project, budgetMin: 80000, budgetMax: 100000 };
  assert.deepEqual(
    bridge.recommend(highBudget).map((r) => r.talentId),
    [1, 2],
  );
});

test("同分人才更新后进入或退出前20名", () => {
  // 25 名完全同分的人才，同分时按编号升序，前 20 名为 1..20。
  const talents: Talent[] = [];
  for (let id = 1; id <= 25; id += 1) {
    talents.push({
      id,
      tags: new Set<ProfessionTag>(["animator"]),
      quality: 300,
      hourlyRate: 10000,
      available: true,
      experienceYears: 10,
    });
  }
  const bridge = new CraftBridge();
  bridge.loadTalents(talents);
  bridge.updateRules({
    weights: { tagMatch: 20, quality: 20, budget: 20, availability: 20, experience: 20 },
    minQuality: 0,
  });
  const project: Project = {
    tags: new Set<ProfessionTag>(["animator"]),
    budgetMin: 10000,
    budgetMax: 10000,
    allowlist: new Set(),
    denylist: new Set(),
  };

  const before = bridge.recommend(project);
  assert.equal(before.length, 20);
  assert.deepEqual(before.map((r) => r.talentId), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(new Set(before.map((r) => r.totalScore)).size === 1, "全部同分");

  // 把 20 号改为低质量且不可接单：20 号退出前 20，21 号（原第 21 顺位）进入。
  bridge.replaceTalent({ ...talents[19], quality: 100, available: false });
  const entered = bridge.recommend(project);
  assert.equal(entered.length, 20);
  assert.ok(!entered.some((r) => r.talentId === 20), "20 号退出前 20");
  assert.equal(entered[19].talentId, 21, "21 号进入并排在第 20 位");

  // 再把 21 号也降级：21 号退出，22 号递补进入前 20。
  bridge.replaceTalent({ ...talents[20], quality: 100, available: false });
  const swapped = bridge.recommend(project);
  assert.equal(swapped.length, 20);
  assert.ok(!swapped.some((r) => r.talentId === 21), "21 号退出前 20");
  assert.equal(swapped[19].talentId, 22, "22 号递补进入前 20");
});

test("禁止名单优先于允许名单，允许名单只豁免质量门槛", () => {
  const talents: Talent[] = [
    { id: 1, tags: new Set<ProfessionTag>(["ux-designer"]), quality: 0, hourlyRate: 100, available: true, experienceYears: 0 },
    { id: 2, tags: new Set<ProfessionTag>(["ux-designer"]), quality: 0, hourlyRate: 100, available: true, experienceYears: 0 },
    { id: 3, tags: new Set<ProfessionTag>(["videographer"]), quality: 0, hourlyRate: 100, available: true, experienceYears: 0 },
  ];
  const bridge = new CraftBridge();
  bridge.loadTalents(talents);
  bridge.updateRules({
    weights: { tagMatch: 20, quality: 20, budget: 20, availability: 20, experience: 20 },
    minQuality: 400,
  });
  const project: Project = {
    tags: new Set<ProfessionTag>(["ux-designer"]),
    budgetMin: 100,
    budgetMax: 100,
    allowlist: new Set([1, 2, 3]),
    denylist: new Set([2]),
  };
  const result = bridge.recommend(project).map((r) => r.talentId);
  assert.deepEqual(result, [1], "1 号被允许豁免质量门槛；2 号禁止优先；3 号无共同标签");
});

test("修改资料与规则后的下一次推荐立即生效", () => {
  const bridge = new CraftBridge();
  bridge.loadTalents([
    { id: 1, tags: new Set<ProfessionTag>(["illustrator"]), quality: 450, hourlyRate: 100, available: true, experienceYears: 40 },
    { id: 2, tags: new Set<ProfessionTag>(["illustrator"]), quality: 10, hourlyRate: 100, available: false, experienceYears: 0 },
  ]);
  const project: Project = {
    tags: new Set<ProfessionTag>(["illustrator"]),
    budgetMin: 100,
    budgetMax: 100,
    allowlist: new Set(),
    denylist: new Set(),
  };
  bridge.updateRules({
    weights: { tagMatch: 0, quality: 100, budget: 0, availability: 0, experience: 0 },
    minQuality: 0,
  });
  assert.deepEqual(bridge.recommend(project).map((r) => r.talentId), [1, 2]);

  // 替换 2 号为高质量人才，下一次推荐必须反超。
  bridge.replaceTalent({ id: 2, tags: new Set<ProfessionTag>(["illustrator"]), quality: 450, hourlyRate: 100, available: true, experienceYears: 40 });
  const ids = bridge.recommend(project).map((r) => r.talentId);
  assert.deepEqual(ids, [1, 2]);
  const scores = bridge.recommend(project);
  assert.equal(scores[0].totalScore, scores[1].totalScore);

  // 提高质量门槛使 1、2 号都不达标（且无允许名单），结果应为空。
  bridge.updateRules({
    weights: { tagMatch: 0, quality: 100, budget: 0, availability: 0, experience: 0 },
    minQuality: 500,
  });
  assert.deepEqual(bridge.recommend(project), []);

  // 整批重新装载后旧人才不得残留。
  bridge.loadTalents([
    { id: 9, tags: new Set<ProfessionTag>(["animator"]), quality: 500, hourlyRate: 100, available: true, experienceYears: 5 },
  ]);
  bridge.updateRules({
    weights: { tagMatch: 20, quality: 20, budget: 20, availability: 20, experience: 20 },
    minQuality: 0,
  });
  assert.deepEqual(bridge.recommend(project), []);
});

test("非法输入抛出 TypeError", () => {
  const bridge = new CraftBridge();
  const good: Talent = {
    id: 1,
    tags: new Set<ProfessionTag>(["illustrator"]),
    quality: 100,
    hourlyRate: 100,
    available: true,
    experienceYears: 3,
  };
  assert.throws(() => bridge.loadTalents([{ ...good, id: 0 }]), TypeError);
  assert.throws(() => bridge.loadTalents([{ ...good, quality: 501 }]), TypeError);
  assert.throws(() => bridge.loadTalents([{ ...good, hourlyRate: 0 }]), TypeError);
  assert.throws(() => bridge.loadTalents([{ ...good, experienceYears: 41 }]), TypeError);
  assert.throws(() => bridge.loadTalents([{ ...good, tags: new Set() }]), TypeError);
  assert.throws(
    () => bridge.loadTalents([{ ...good, tags: new Set(["chef" as ProfessionTag]) }]),
    TypeError,
  );
  assert.throws(() => bridge.loadTalents([good, good]), TypeError);
  assert.throws(
    () =>
      bridge.updateRules({
        weights: { tagMatch: 20, quality: 20, budget: 20, availability: 20, experience: 21 },
        minQuality: 0,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      bridge.updateRules({
        weights: { tagMatch: -1, quality: 26, budget: 25, availability: 25, experience: 25 },
        minQuality: 0,
      }),
    TypeError,
  );
  bridge.loadTalents([good]);
  const project: Project = {
    tags: new Set<ProfessionTag>(["illustrator"]),
    budgetMin: 100,
    budgetMax: 100,
    allowlist: new Set(),
    denylist: new Set(),
  };
  assert.throws(() => bridge.recommend({ ...project, budgetMin: 200 }), TypeError);
  assert.throws(() => bridge.recommend({ ...project, budgetMax: 0 }), TypeError);
});

test("随机场景下与独立参考实现逐项一致", () => {
  const rand = mulberry32(20261008);
  const bridge = new CraftBridge();
  let talents: Talent[] = [];
  for (let id = 1; id <= 60; id += 1) talents.push(randomTalent(rand, id));
  bridge.loadTalents(talents);

  for (let round = 0; round < 200; round += 1) {
    // 每轮随机修改：替换若干人才、调整规则，验证下一次推荐立即使用新值。
    for (let k = 0; k < 3; k += 1) {
      const id = 1 + Math.floor(rand() * talents.length);
      const updated = randomTalent(rand, id);
      talents = talents.map((t) => (t.id === id ? updated : t));
      bridge.replaceTalent(updated);
    }
    const rules = randomRules(rand);
    bridge.updateRules(rules);
    const project = randomProject(rand, talents.map((t) => t.id));

    const expected = refRecommend(talents, project, rules);
    const actual = bridge.recommend(project);
    assert.deepEqual(actual, expected, `第 ${round} 轮推荐结果与参考实现不一致`);
  }
});

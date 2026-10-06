import test from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { routeBatch } from "../src/index.js";
import type { Lead, TeamSnapshot } from "../src/index.js";

function rep(
  id: string,
  industries: string[],
  historicalCount = 0,
  available = true,
) {
  return {
    id,
    available,
    skills: industries.map((industry) => ({
      industry,
      minBudgetCents: 0,
      maxBudgetCents: Number.MAX_SAFE_INTEGER,
    })),
    historicalCount,
  };
}

function lead(id: string, industry: string, budgetCents = 100_00): Lead {
  return { id, industry, budgetCents };
}

test("全局均衡优先：两条线索须先给乙再给甲，而非都堆给甲", () => {
  // 甲、乙历史均为 0，起点为甲。
  // L1 甲乙都可候选，L2 只有甲候选。
  // 方案 (甲,甲)：累计 (2,0)，均衡值 4；方案 (乙,甲)：累计 (1,1)，均衡值 2。
  // 必须选全局最小的 (乙,甲)，即使第一条当时给甲看起来同样“均衡”。
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家电"]), rep("乙", ["家电"])],
    rotationStart: 0,
  };
  // 让 L2 只能给甲：乙的技能预算区间不含 20000。
  snapshot.roster[1].skills = [
    { industry: "家电", minBudgetCents: 0, maxBudgetCents: 150_00 },
  ];
  const r = routeBatch(snapshot, [lead("L1", "家电"), lead("L2", "家电", 200_00)]);
  deepEqual(
    r.assignments.map((a) => a.repId),
    ["乙", "甲"],
  );
  equal(r.state.roster[0].historicalCount, 1);
  equal(r.state.roster[1].historicalCount, 1);
  // 最后分配给甲（下标 0），起点移到其下一位 → 乙（下标 1）。
  equal(r.state.rotationStart, 1);
});

test("均衡值相同时按轮转步数裁决：步数更少者优先", () => {
  // 历史 (0,0)，起点甲，两条线索甲乙都可选。
  // 达到 (1,1) 的方案有 (甲,乙) 步数 [0,0] 与 (乙,甲) 步数 [1,0]，前者优先。
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家电"]), rep("乙", ["家电"])],
    rotationStart: 0,
  };
  const r = routeBatch(snapshot, [lead("L1", "家电"), lead("L2", "家电")]);
  deepEqual(
    r.assignments.map((a) => a.repId),
    ["甲", "乙"],
  );
  equal(r.state.rotationStart, 0); // 乙的下一位回绕到甲
});

test("裁决按线索顺序逐条比较：前面相同才比较后面", () => {
  // 三名销售，起点甲，历史均 0。L1 只能给乙或丙，L2 三人都可。
  // 最优均衡值要求 (1,1,0) 的某种分布……L1 给乙（步数1）还是丙（步数2）？
  // 方案A: L1→乙(步1,起点丙), L2→丙(步0) → 步数 [1,0], 计数 (0,1,1)
  // 方案B: L1→丙(步2,起点甲), L2→甲(步0) → 步数 [2,0], 计数 (1,0,1)
  // 两者均衡值都是 2，方案A 首条步数更小，选 A。
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家具"]), rep("乙", ["家电"]), rep("丙", ["家电"])],
    rotationStart: 0,
  };
  const r = routeBatch(snapshot, [lead("L1", "家电"), lead("L2", "家电")]);
  // 甲不是 L1 候选人（行业不匹配）。
  deepEqual(
    r.assignments.map((a) => a.repId),
    ["乙", "丙"],
  );
  equal(r.state.rotationStart, 0); // 丙的下一位回绕到甲
});

test("技能匹配：预算区间下界包含、上界不包含，行业须相同", () => {
  const snapshot: TeamSnapshot = {
    roster: [
      {
        id: "甲",
        available: true,
        skills: [{ industry: "家电", minBudgetCents: 100_00, maxBudgetCents: 200_00 }],
        historicalCount: 0,
      },
      rep("乙", ["家电", "家具"], 5),
    ],
    rotationStart: 0,
  };
  // 预算恰好等于下界 → 甲候选；甲历史 0 < 乙历史 5，必给甲。
  const atMin = routeBatch(snapshot, [lead("L1", "家电", 100_00)]);
  equal(atMin.assignments[0].repId, "甲");
  // 预算恰好等于上界 → 甲不候选，只能给乙。
  const atMax = routeBatch(snapshot, [lead("L1", "家电", 200_00)]);
  equal(atMax.assignments[0].repId, "乙");
  // 行业不同 → 甲不候选。
  const otherIndustry = routeBatch(snapshot, [lead("L1", "家具", 150_00)]);
  equal(otherIndustry.assignments[0].repId, "乙");
});

test("不可用销售不是候选人，但历史累计数保留", () => {
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家电"], 7, false), rep("乙", ["家电"], 0)],
    rotationStart: 0,
  };
  const r = routeBatch(snapshot, [lead("L1", "家电")]);
  equal(r.assignments[0].repId, "乙");
  equal(r.state.roster[0].historicalCount, 7); // 不清零
  equal(r.state.roster[1].historicalCount, 1);
});

test("无候选人的线索保持未分配，不改计数与起点", () => {
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家电"], 3), rep("乙", ["家电"], 4)],
    rotationStart: 1,
  };
  const r = routeBatch(snapshot, [lead("L1", "家具"), lead("L2", "家电")]);
  equal(r.assignments[0].repId, null);
  equal(r.assignments[1].repId, "甲"); // 历史 3 < 4
  equal(r.state.roster[0].historicalCount, 4);
  equal(r.state.roster[1].historicalCount, 4);
  equal(r.state.rotationStart, 1); // 甲的下一位是乙
});

test("相同快照与输入产生完全相同的结果", () => {
  const snapshot: TeamSnapshot = {
    roster: [rep("甲", ["家电"], 2), rep("乙", ["家电", "家具"], 1), rep("丙", ["家具"], 0)],
    rotationStart: 2,
  };
  const leads = [lead("L1", "家电"), lead("L2", "家具", 50_00), lead("L3", "家电")];
  const a = routeBatch(snapshot, leads);
  const b = routeBatch(structuredClone(snapshot), leads.map((l) => ({ ...l })));
  deepEqual(a, b);
});

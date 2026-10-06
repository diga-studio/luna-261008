import test from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { routeBatch } from "../src/index.js";
import type { Lead, TeamSnapshot } from "../src/index.js";

function makeSnapshot(): TeamSnapshot {
  return {
    roster: [
      {
        id: "甲",
        available: true,
        skills: [{ industry: "家电", minBudgetCents: 0, maxBudgetCents: 300_00 }],
        historicalCount: 0,
      },
      {
        id: "乙",
        available: true,
        skills: [
          { industry: "家电", minBudgetCents: 0, maxBudgetCents: 300_00 },
          { industry: "家具", minBudgetCents: 0, maxBudgetCents: 500_00 },
        ],
        historicalCount: 0,
      },
      {
        id: "丙",
        available: true,
        skills: [{ industry: "家具", minBudgetCents: 100_00, maxBudgetCents: 500_00 }],
        historicalCount: 0,
      },
    ],
    rotationStart: 0,
  };
}

const batch1: Lead[] = [
  { id: "B1-1", industry: "家电", budgetCents: 100_00 },
  { id: "B1-2", industry: "家具", budgetCents: 200_00 },
  { id: "B1-3", industry: "家电", budgetCents: 150_00 },
];
const batch2: Lead[] = [
  { id: "B2-1", industry: "家具", budgetCents: 300_00 },
  { id: "B2-2", industry: "家电", budgetCents: 80_00 },
];
const batch3: Lead[] = [
  { id: "B3-1", industry: "家电", budgetCents: 120_00 },
  { id: "B3-2", industry: "家具", budgetCents: 250_00 },
  { id: "B3-3", industry: "家电", budgetCents: 90_00 },
  { id: "B3-4", industry: "家具", budgetCents: 400_00 },
];

test("多批连续分配：状态读出重载后与连续调用完全一致（含不可用成员恢复）", () => {
  // 路径一：内存中连续路由三批。第二批前乙暂时不可用，第三批前恢复。
  const s0 = makeSnapshot();
  const r1 = routeBatch(s0, batch1);

  const s1 = structuredClone(r1.state);
  s1.roster[1].available = false; // 乙暂时不可用，累计数保留
  const r2 = routeBatch(s1, batch2);
  equal(r2.state.roster[1].historicalCount, r1.state.roster[1].historicalCount);

  const s2 = structuredClone(r2.state);
  s2.roster[1].available = true; // 恢复
  const r3 = routeBatch(s2, batch3);

  // 路径二：每批结束后把状态 JSON 序列化“读出”，下一批前重新载入。
  const j0: TeamSnapshot = JSON.parse(JSON.stringify(makeSnapshot()));
  const j1 = routeBatch(j0, batch1);
  const saved1: TeamSnapshot = JSON.parse(JSON.stringify(j1.state));
  saved1.roster[1].available = false;
  const j2 = routeBatch(saved1, batch2);
  const saved2: TeamSnapshot = JSON.parse(JSON.stringify(j2.state));
  saved2.roster[1].available = true;
  const j3 = routeBatch(saved2, batch3);

  // 两条路径的逐条分配、最终累计数与轮转起点必须完全一致。
  deepEqual(j1.assignments, r1.assignments);
  deepEqual(j2.assignments, r2.assignments);
  deepEqual(j3.assignments, r3.assignments);
  deepEqual(j3.state, r3.state);

  // 累计数守恒：三人合计 = 三批线索总数（每批每条都有候选人）。
  const total = batch1.length + batch2.length + batch3.length;
  equal(
    r3.state.roster.reduce((sum, rep) => sum + rep.historicalCount, 0),
    total,
  );
  // 轮转起点是合法下标。
  equal(r3.state.rotationStart >= 0 && r3.state.rotationStart < 3, true);
});

test("不可用成员恢复后按累计数重新参与均衡", () => {
  // 乙积累较多后不可用一批，恢复后其累计数仍在，下一轮应优先补给甲。
  const snapshot: TeamSnapshot = {
    roster: [
      {
        id: "甲",
        available: true,
        skills: [{ industry: "家电", minBudgetCents: 0, maxBudgetCents: 300_00 }],
        historicalCount: 0,
      },
      {
        id: "乙",
        available: false,
        skills: [{ industry: "家电", minBudgetCents: 0, maxBudgetCents: 300_00 }],
        historicalCount: 5,
      },
    ],
    rotationStart: 0,
  };
  const whileAway = routeBatch(snapshot, [
    { id: "L1", industry: "家电", budgetCents: 100_00 },
  ]);
  equal(whileAway.assignments[0].repId, "甲");
  equal(whileAway.state.roster[1].historicalCount, 5); // 不可用期间不清零

  const restored = structuredClone(whileAway.state);
  restored.roster[1].available = true;
  // 甲累计 1、乙累计 5，接下来两条都应给甲才能最小化均衡值。
  const after = routeBatch(restored, [
    { id: "L2", industry: "家电", budgetCents: 100_00 },
    { id: "L3", industry: "家电", budgetCents: 100_00 },
  ]);
  deepEqual(
    after.assignments.map((a) => a.repId),
    ["甲", "甲"],
  );
  equal(after.state.roster[0].historicalCount, 3);
  equal(after.state.roster[1].historicalCount, 5);
});

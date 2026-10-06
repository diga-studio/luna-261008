import test from "node:test";
import { deepEqual } from "node:assert/strict";
import { routeBatch } from "../src/index.js";
import type { Lead, TeamSnapshot } from "../src/index.js";

/** 可复现的伪随机数（LCG），避免测试依赖 Math.random。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface BruteResult {
  cost: number;
  steps: number[];
  assign: number[];
}

/** 暴力枚举所有完整分配方案，返回 (均衡值, 步数序列) 字典序最小的方案。 */
function bruteForce(
  historicalCounts: number[],
  rotationStart: number,
  candidatesPerLead: number[][],
): BruteResult {
  const n = historicalCounts.length;
  let best: BruteResult | null = null;
  const assign = new Array<number>(candidatesPerLead.length).fill(-1);

  function stepsOf(a: number[]): number[] {
    const steps: number[] = [];
    let start = rotationStart;
    for (const repIndex of a) {
      if (repIndex < 0) continue;
      steps.push((repIndex - start + n) % n);
      start = (repIndex + 1) % n;
    }
    return steps;
  }

  function consider(a: number[]): void {
    const counts = historicalCounts.slice();
    for (const repIndex of a) if (repIndex >= 0) counts[repIndex] += 1;
    const cost = counts.reduce((sum, c) => sum + c * c, 0);
    const steps = stepsOf(a);
    if (
      !best ||
      cost < best.cost ||
      (cost === best.cost && lexLess(steps, best.steps))
    ) {
      best = { cost, steps, assign: a.slice() };
    }
  }

  function lexLess(a: number[], b: number[]): boolean {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length < b.length;
  }

  function walk(leadIndex: number): void {
    if (leadIndex === candidatesPerLead.length) {
      consider(assign);
      return;
    }
    const candidates = candidatesPerLead[leadIndex];
    if (candidates.length === 0) {
      assign[leadIndex] = -1;
      walk(leadIndex + 1);
      return;
    }
    for (const repIndex of candidates) {
      assign[leadIndex] = repIndex;
      walk(leadIndex + 1);
    }
  }
  walk(0);
  return best!;
}

test("随机小规模用例与暴力枚举的全局最优解一致", () => {
  const rng = makeRng(20261008);
  const industries = ["家电", "家具", "汽车"];
  for (let trial = 0; trial < 200; trial++) {
    const repCount = 2 + Math.floor(rng() * 3); // 2-4 名销售
    const roster = Array.from({ length: repCount }, (_, i) => ({
      id: `R${i}`,
      available: rng() < 0.8,
      skills: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => {
        const min = Math.floor(rng() * 5) * 100_00;
        return {
          industry: industries[Math.floor(rng() * industries.length)],
          minBudgetCents: min,
          maxBudgetCents: min + (1 + Math.floor(rng() * 4)) * 100_00,
        };
      }),
      historicalCount: Math.floor(rng() * 6),
    }));
    const snapshot: TeamSnapshot = {
      roster,
      rotationStart: Math.floor(rng() * repCount),
    };
    const leadCount = 1 + Math.floor(rng() * 5); // 1-5 条线索
    const leads: Lead[] = Array.from({ length: leadCount }, (_, i) => ({
      id: `L${i}`,
      industry: industries[Math.floor(rng() * industries.length)],
      budgetCents: Math.floor(rng() * 9) * 100_00,
    }));

    const candidatesPerLead = leads.map((lead) =>
      roster
        .map((rep, i) => ({ rep, i }))
        .filter(
          ({ rep }) =>
            rep.available &&
            rep.skills.some(
              (s) =>
                s.industry === lead.industry &&
                lead.budgetCents >= s.minBudgetCents &&
                lead.budgetCents < s.maxBudgetCents,
            ),
        )
        .map(({ i }) => i),
    );

    // 控制枚举规模，跳过极端组合（本测试只验证正确性，不压测性能）。
    const combos = candidatesPerLead.reduce(
      (acc, c) => acc * Math.max(1, c.length),
      1,
    );
    if (combos > 20000) continue;

    const expected = bruteForce(
      roster.map((r) => r.historicalCount),
      snapshot.rotationStart,
      candidatesPerLead,
    );
    const actual = routeBatch(snapshot, leads);
    const actualIndices = actual.assignments.map((a) =>
      a.repId === null ? -1 : roster.findIndex((r) => r.id === a.repId),
    );
    deepEqual(
      actualIndices,
      expected.assign,
      `trial ${trial}: 分配方案应与暴力最优一致`,
    );

    // 状态更新也与方案一致：累计数与轮转起点。
    const finalCounts = roster.map((r) => r.historicalCount);
    let start = snapshot.rotationStart;
    for (const repIndex of expected.assign) {
      if (repIndex < 0) continue;
      finalCounts[repIndex] += 1;
      start = (repIndex + 1) % repCount;
    }
    deepEqual(
      actual.state.roster.map((r) => r.historicalCount),
      finalCounts,
      `trial ${trial}: 累计数`,
    );
    deepEqual(actual.state.rotationStart, start, `trial ${trial}: 轮转起点`);
  }
});

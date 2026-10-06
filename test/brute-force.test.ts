import { test } from "node:test";
import assert from "node:assert/strict";
import { LeadRouter } from "../src/index.ts";
import { candidateIndices } from "../src/matching.ts";
import type { Lead, TeamSnapshot } from "../src/index.ts";

/** 测试内独立实现的穷举器：枚举全部完整方案，按规则选出最优，用于交叉验证。 */
function bruteForce(snap: TeamSnapshot, leads: Lead[]): (string | null)[] {
  const n = snap.reps.length;
  const cands = leads.map((l) => candidateIndices(snap.reps, l));
  let bestSum = Infinity;
  let bestSteps: number[] = [];
  let best: (number | null)[] = [];

  const counts = snap.reps.map((r) => r.assignedCount);
  const chosen: (number | null)[] = new Array(leads.length).fill(null);
  const steps: number[] = [];

  const visit = (i: number, pointer: number): void => {
    if (i === leads.length) {
      const sum = counts.reduce((a, c) => a + c * c, 0);
      if (
        sum < bestSum ||
        (sum === bestSum && steps.join(",") < bestSteps.join(","))
      ) {
        bestSum = sum;
        bestSteps = [...steps];
        best = [...chosen];
      }
      return;
    }
    if (cands[i].length === 0) {
      visit(i + 1, pointer);
      return;
    }
    for (const r of cands[i]) {
      chosen[i] = r;
      counts[r] += 1;
      steps.push((r - pointer + n) % n);
      visit(i + 1, (r + 1) % n);
      steps.pop();
      counts[r] -= 1;
      chosen[i] = null;
    }
  };
  visit(0, snap.rotationStart);
  return best.map((r) => (r === null ? null : snap.reps[r].id));
}

/** 确定性伪随机数（LCG），保证测试可复现。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("随机小场景与穷举器交叉验证：均衡值全局最小且轮转裁决一致", () => {
  const rand = rng(20261008);
  const industries = ["tech", "finance", "health"];
  for (let round = 0; round < 200; round++) {
    const n = 2 + Math.floor(rand() * 3); // 2~4 名销售
    const snap: TeamSnapshot = {
      reps: Array.from({ length: n }, (_, i) => ({
        id: `R${i}`,
        available: rand() < 0.8,
        assignedCount: Math.floor(rand() * 4),
        skills: Array.from({ length: 1 + Math.floor(rand() * 2) }, () => {
          const lo = Math.floor(rand() * 5) * 100;
          return {
            industry: industries[Math.floor(rand() * industries.length)],
            minBudget: lo,
            maxBudget: lo + 100 * (1 + Math.floor(rand() * 3)),
          };
        }),
      })),
      rotationStart: Math.floor(rand() * n),
    };
    const leads: Lead[] = Array.from(
      { length: 1 + Math.floor(rand() * 5) },
      (_, i) => ({
        id: `L${i}`,
        industry: industries[Math.floor(rand() * industries.length)],
        budget: Math.floor(rand() * 6) * 100,
      }),
    );
    const router = new LeadRouter(snap);
    const got = router.routeBatch(leads).assignments.map((a) => a.assignee);
    const want = bruteForce(snap, leads);
    assert.deepEqual(got, want, `round ${round}: ${JSON.stringify({ snap, leads })}`);
  }
});

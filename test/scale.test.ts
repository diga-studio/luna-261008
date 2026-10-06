import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { CommissionEngine } from "../src/engine.js";
import type { Deal, PlanVersion } from "../src/types.js";
import { referenceExplain } from "./reference.js";

const PLANS: PlanVersion[] = [
  {
    id: "plan-q1",
    startDate: "01/01/2026",
    endDate: "03/31/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 500 },
      { thresholdCents: "100000000", rateBps: 750 },
      { thresholdCents: "500000000", rateBps: 1000 },
      { thresholdCents: "2000000000", rateBps: 1500 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 250 },
      { thresholdCents: "300000000", rateBps: 400 },
    ],
  },
];

const DEAL_COUNT = 200_000;
const REVISION_COUNT = 2_000;
const id = (i: number): string => `D${String(i).padStart(6, "0")}`;
const amount = (i: number): string => String(((i * 7919) % 100000) + 1);

test("scale: 200k same-day deals, 2000 interleaved early revisions and tail queries", () => {
  const engine = new CommissionEngine(PLANS);
  const mirror = new Map<string, Deal>();

  const loadStart = performance.now();
  for (let i = 0; i < DEAL_COUNT; i += 1) {
    const deal: Deal = {
      externalId: id(i),
      amountCents: amount(i),
      closeDate: "02/15/2026",
      dealType: i % 3 === 0 ? "renewal" : "newBusiness",
    };
    engine.upsertDeal(deal);
    mirror.set(deal.externalId, deal);
  }
  const loadMs = performance.now() - loadStart;

  const tailId = id(DEAL_COUNT - 1);
  let reviseMs = 0;
  let queryMs = 0;
  for (let op = 0; op < REVISION_COUNT; op += 1) {
    // 修订集中在最前面的 1000 笔（早期成交），会改变后续所有成交的累计值。
    const targetId = id(op % 1000);
    const revised: Deal = {
      externalId: targetId,
      amountCents: String(((op * 104729) % 200000) + 7),
      closeDate: "02/15/2026",
      dealType: op % 2 === 0 ? "newBusiness" : "renewal",
    };
    const t0 = performance.now();
    engine.upsertDeal(revised);
    reviseMs += performance.now() - t0;
    mirror.set(targetId, revised);

    const t1 = performance.now();
    const explanation = engine.explainDeal(tailId);
    queryMs += performance.now() - t1;

    // 每 100 次用全量排序参考计算器逐字段校验一次末端成交。
    if (op % 100 === 99) {
      const expected = referenceExplain(mirror, PLANS, tailId);
      assert.equal(explanation.priorCumulativeCents, expected.priorCumulativeCents);
      assert.equal(explanation.planVersionId, expected.planVersionId);
      assert.deepEqual(explanation.slices, expected.slices);
      assert.equal(explanation.payableCents, expected.payableCents);
    }
  }

  // 最终再对若干不同位置的成交做一次全量校验。
  for (const probe of [id(0), id(500), id(100000), tailId]) {
    const actual = engine.explainDeal(probe);
    const expected = referenceExplain(mirror, PLANS, probe);
    assert.equal(actual.priorCumulativeCents, expected.priorCumulativeCents);
    assert.deepEqual(actual.slices, expected.slices);
    assert.equal(actual.payableCents, expected.payableCents);
  }

  console.log(
    [
      `scale test timings (${DEAL_COUNT} deals, ${REVISION_COUNT} revisions):`,
      `  load:    ${loadMs.toFixed(1)}ms total, ${((loadMs * 1000) / DEAL_COUNT).toFixed(2)}us/deal`,
      `  revise:  ${reviseMs.toFixed(1)}ms total, ${((reviseMs * 1000) / REVISION_COUNT).toFixed(2)}us/op`,
      `  query:   ${queryMs.toFixed(1)}ms total, ${((queryMs * 1000) / REVISION_COUNT).toFixed(2)}us/op`,
    ].join("\n"),
  );
});

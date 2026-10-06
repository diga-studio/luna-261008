import assert from "node:assert/strict";
import test from "node:test";
import { CommissionEngine } from "../src/engine.js";
import type { PlanVersion } from "../src/types.js";

const Q1 = { startDate: "01/01/2026", endDate: "03/31/2026" };

test("整单舍入：跨档成交不得逐切片舍入", () => {
  // 档1 [0,5000) 1bp；档2 [5000,∞) 3bps。一单 10000 分跨两档。
  // 逐切片舍入：round(5000*1/10000)=1，round(5000*3/10000)=2，合计 3。
  // 整单舍入：(5000*1 + 5000*3)/10000 = 2。引擎必须输出 2。
  const plans: PlanVersion[] = [
    {
      id: "p1",
      ...Q1,
      newBusinessTiers: [
        { thresholdCents: "0", rateBps: 1 },
        { thresholdCents: "5000", rateBps: 3 },
      ],
      renewalTiers: [{ thresholdCents: "0", rateBps: 0 }],
    },
  ];
  const engine = new CommissionEngine(plans);
  engine.upsertDeal({ externalId: "X1", amountCents: "10000", closeDate: "02/10/2026", dealType: "newBusiness" });
  const explanation = engine.explainDeal("X1");
  assert.equal(explanation.slices.length, 2);
  assert.deepEqual(
    explanation.slices.map((s) => [s.fromCumulativeCents, s.toCumulativeCents, s.amountCents, s.rateBps]),
    [
      ["0", "5000", "5000", 1],
      ["5000", "10000", "5000", 3],
    ],
  );
  assert.equal(explanation.payableCents, "2");
});

test("恰好半分向上舍入", () => {
  const plans: PlanVersion[] = [
    {
      id: "p1",
      ...Q1,
      newBusinessTiers: [{ thresholdCents: "0", rateBps: 1 }],
      renewalTiers: [{ thresholdCents: "0", rateBps: 0 }],
    },
  ];
  const engine = new CommissionEngine(plans);
  // 5000 * 1 / 10000 = 0.5，恰好半分，向上得 1。
  engine.upsertDeal({ externalId: "H1", amountCents: "5000", closeDate: "01/15/2026", dealType: "newBusiness" });
  assert.equal(engine.explainDeal("H1").payableCents, "1");
  // 4999 * 1 / 10000 = 0.4999，向下得 0。
  engine.upsertDeal({ externalId: "H2", amountCents: "4999", closeDate: "01/15/2026", dealType: "newBusiness" });
  assert.equal(engine.explainDeal("H2").payableCents, "0");
});

test("超过 Number 安全整数的累计金额与切片边界", () => {
  // 2^53+1 与 2^54 均无法被 Number 精确表示，必须用 BigInt 精确处理。
  const TWO53_PLUS1 = "9007199254740993";
  const TWO54 = "18014398509481984";
  const plans: PlanVersion[] = [
    {
      id: "p1",
      ...Q1,
      newBusinessTiers: [
        { thresholdCents: "0", rateBps: 10000 },
        { thresholdCents: TWO54, rateBps: 5000 },
      ],
      renewalTiers: [{ thresholdCents: "0", rateBps: 0 }],
    },
  ];
  const engine = new CommissionEngine(plans);
  engine.upsertDeal({ externalId: "A", amountCents: TWO53_PLUS1, closeDate: "03/01/2026", dealType: "newBusiness" });
  engine.upsertDeal({ externalId: "B", amountCents: "9007199254740994", closeDate: "03/01/2026", dealType: "newBusiness" });

  const b = engine.explainDeal("B");
  assert.equal(b.priorCumulativeCents, TWO53_PLUS1);
  // B 覆盖 [2^53+1, 2^53+1 + 2^53+2) = [9007199254740993, 18014398509481987)，跨过 2^54 门槛。
  assert.deepEqual(
    b.slices.map((s) => [s.fromCumulativeCents, s.toCumulativeCents, s.amountCents, s.rateBps]),
    [
      [TWO53_PLUS1, TWO54, "9007199254740991", 10000],
      [TWO54, "18014398509481987", "3", 5000],
    ],
  );
  // (9007199254740991*10000 + 3*5000) / 10000 = 9007199254740992.5 → 半分向上 = 9007199254740993。
  assert.equal(b.payableCents, "9007199254740993");

  // 修改早期成交后，B 的前序累计与切片必须随之改变（B 本身未被修改）。
  engine.upsertDeal({ externalId: "A", amountCents: "1", closeDate: "03/01/2026", dealType: "newBusiness" });
  const bAfter = engine.explainDeal("B");
  assert.equal(bAfter.priorCumulativeCents, "1");
  assert.equal(bAfter.slices.length, 1);
  assert.equal(bAfter.slices[0].rateBps, 10000);
  assert.equal(bAfter.payableCents, "9007199254740994");
});

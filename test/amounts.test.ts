import { describe, expect, it } from "vitest";
import { CommissionEngine } from "../src/engine.js";
import type { PlanVersion } from "../src/types.js";

const SINGLE_VERSION_PLAN: PlanVersion[] = [
  {
    id: "only",
    effectiveFrom: "01/01/2026",
    effectiveTo: "03/31/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 100 },
      { thresholdCents: "1000000", rateBps: 100 },
      { thresholdCents: "2000000", rateBps: 300 },
    ],
    renewalTiers: [{ thresholdCents: "0", rateBps: 50 }],
  },
];

describe("directed amount tests", () => {
  it("rounds once on the whole deal, not per slice", () => {
    const engine = new CommissionEngine(SINGLE_VERSION_PLAN);
    // 前序累计顶到 999950，使本单恰好跨 1000000 门槛，两片各 50 分 @100bps。
    engine.upsertDeal({
      externalId: "PAD",
      amountCents: "999950",
      closeDate: "01/01/2026",
      dealType: "RENEWAL",
    });
    engine.upsertDeal({
      externalId: "TARGET",
      amountCents: "100",
      closeDate: "01/02/2026",
      dealType: "NEW_BUSINESS",
    });
    const explanation = engine.explainDeal("TARGET");
    expect(explanation.slices).toEqual([
      { fromCents: "999950", toCents: "1000000", amountCents: "50", rateBps: 100 },
      { fromCents: "1000000", toCents: "1000050", amountCents: "50", rateBps: 100 },
    ]);
    // 逐片舍入：50*100/10000=0.5 -> 1，两片合计 2；整单舍入：10000/10000=1。
    expect(explanation.paymentCents).toBe("1");
  });

  it("rounds half up exactly at half a cent", () => {
    const engine = new CommissionEngine(SINGLE_VERSION_PLAN);
    // 50 分 @100bps => 加权 5000，恰好半分，向上。
    engine.upsertDeal({
      externalId: "HALF",
      amountCents: "50",
      closeDate: "01/01/2026",
      dealType: "NEW_BUSINESS",
    });
    expect(engine.explainDeal("HALF").paymentCents).toBe("1");
    // 49 分 @100bps => 4900 < 5000，向下。
    engine.upsertDeal({
      externalId: "HALF",
      amountCents: "49",
      closeDate: "01/01/2026",
      dealType: "NEW_BUSINESS",
    });
    expect(engine.explainDeal("HALF").paymentCents).toBe("0");
  });

  it("handles accumulation beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const engine = new CommissionEngine(SINGLE_VERSION_PLAN);
    const big = "9007199254740993"; // 2^53 + 1，Number 无法精确表示
    engine.upsertDeal({
      externalId: "BIG",
      amountCents: big,
      closeDate: "01/01/2026",
      dealType: "NEW_BUSINESS",
    });
    engine.upsertDeal({
      externalId: "AFTER",
      amountCents: "100000",
      closeDate: "01/02/2026",
      dealType: "NEW_BUSINESS",
    });
    const explanation = engine.explainDeal("AFTER");
    expect(explanation.priorAccumulatedCents).toBe(big);
    // 整单落在最高档（>=2000000, 300bps）
    expect(explanation.slices).toEqual([
      {
        fromCents: "9007199254740993",
        toCents: "9007199254840993",
        amountCents: "100000",
        rateBps: 300,
      },
    ]);
    // 100000 * 300 / 10000 = 3000
    expect(explanation.paymentCents).toBe("3000");

    // 大单本身跨全部三档，验证超大数下的切片边界。
    const bigExplanation = engine.explainDeal("BIG");
    expect(bigExplanation.slices).toEqual([
      { fromCents: "0", toCents: "1000000", amountCents: "1000000", rateBps: 100 },
      { fromCents: "1000000", toCents: "2000000", amountCents: "1000000", rateBps: 100 },
      {
        fromCents: "2000000",
        toCents: "9007199254740993",
        amountCents: "9007199252740993",
        rateBps: 300,
      },
    ]);
    // 加权 = 1000000*100 + 1000000*100 + 9007199252740993*300
    //      = 2702159776022297900 分·基点 -> /10000 = 270215977602229.79 -> 270215977602230
    expect(bigExplanation.paymentCents).toBe("270215977602230");
  });

  it("recomputes tiers for later deals after an early deal is removed", () => {
    const engine = new CommissionEngine(SINGLE_VERSION_PLAN);
    engine.upsertDeal({
      externalId: "EARLY",
      amountCents: "1500000",
      closeDate: "01/01/2026",
      dealType: "NEW_BUSINESS",
    });
    engine.upsertDeal({
      externalId: "LATE",
      amountCents: "1000000",
      closeDate: "01/02/2026",
      dealType: "NEW_BUSINESS",
    });
    const before = engine.explainDeal("LATE");
    expect(before.priorAccumulatedCents).toBe("1500000");
    expect(before.slices.map((s) => s.rateBps)).toEqual([100, 300]);

    engine.removeDeal("EARLY");
    const after = engine.explainDeal("LATE");
    expect(after.priorAccumulatedCents).toBe("0");
    expect(after.slices).toEqual([
      { fromCents: "0", toCents: "1000000", amountCents: "1000000", rateBps: 100 },
    ]);
    expect(after.paymentCents).toBe("10000");
  });
});

import { describe, expect, it } from "vitest";
import { CommissionEngine } from "../src/engine.js";
import type { DealInput, DealType, PlanVersion } from "../src/types.js";
import { ReferenceCalculator } from "./reference.js";

export const TEST_PLAN: PlanVersion[] = [
  {
    id: "plan-v1",
    effectiveFrom: "01/01/2026",
    effectiveTo: "02/14/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 500 },
      { thresholdCents: "1000000", rateBps: 1000 },
      { thresholdCents: "5000000", rateBps: 1500 },
      { thresholdCents: "20000000", rateBps: 2000 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 300 },
      { thresholdCents: "2000000", rateBps: 800 },
    ],
  },
  {
    id: "plan-v2",
    effectiveFrom: "02/15/2026",
    effectiveTo: "03/31/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 400 },
      { thresholdCents: "3000000", rateBps: 900 },
      { thresholdCents: "10000000", rateBps: 1600 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 250 },
      { thresholdCents: "1500000", rateBps: 700 },
      { thresholdCents: "8000000", rateBps: 1200 },
    ],
  },
];

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

const DAYS: string[] = (() => {
  const days: string[] = [];
  const push = (m: number, count: number) => {
    for (let d = 1; d <= count; d += 1) {
      days.push(
        `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/2026`,
      );
    }
  };
  push(1, 31);
  push(2, 28);
  push(3, 31);
  return days;
})();

function randomDeal(rand: () => number, id: string): DealInput {
  const roll = rand();
  let amount: string;
  if (roll < 0.1) {
    // 超大金额，越过 Number.MAX_SAFE_INTEGER
    amount = (BigInt("9007199254740991") + BigInt(Math.floor(rand() * 1e12))).toString();
  } else if (roll < 0.4) {
    // 跨档金额
    amount = String(1 + Math.floor(rand() * 25_000_000));
  } else {
    amount = String(Math.floor(rand() * 1_000_000));
  }
  const dealType: DealType = rand() < 0.5 ? "NEW_BUSINESS" : "RENEWAL";
  return {
    externalId: id,
    amountCents: amount,
    closeDate: DAYS[Math.floor(rand() * DAYS.length)]!,
    dealType,
  };
}

describe("randomized differential test vs reference calculator", () => {
  it("interleaved upsert/remove/explain with fixed seed", () => {
    const rand = mulberry32(20260101);
    const engine = new CommissionEngine(TEST_PLAN);
    const reference = new ReferenceCalculator(TEST_PLAN);
    const live = new Set<string>();
    const idPool: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      idPool.push(`DEAL${String(i).padStart(4, "0")}`);
    }

    let explainCount = 0;
    for (let op = 0; op < 4000; op += 1) {
      const roll = rand();
      if (roll < 0.55 || live.size === 0) {
        const id = idPool[Math.floor(rand() * idPool.length)]!;
        const deal = randomDeal(rand, id);
        engine.upsertDeal(deal);
        reference.upsertDeal(deal);
        live.add(id);
      } else if (roll < 0.75) {
        const ids = [...live];
        const id = ids[Math.floor(rand() * ids.length)]!;
        engine.removeDeal(id);
        reference.removeDeal(id);
        live.delete(id);
      } else {
        const ids = [...live];
        const id = ids[Math.floor(rand() * ids.length)]!;
        const actual = engine.explainDeal(id);
        const expected = reference.explainDeal(id);
        expect(actual.externalId).toBe(expected.externalId);
        expect(actual.priorAccumulatedCents).toBe(
          expected.priorAccumulatedCents,
        );
        expect(actual.planVersionId).toBe(expected.planVersionId);
        expect(actual.slices).toEqual(expected.slices);
        expect(actual.paymentCents).toBe(expected.paymentCents);
        explainCount += 1;
      }
    }
    expect(explainCount).toBeGreaterThan(500);
  });

  it("same-day deals ordered by externalId ASCII order", () => {
    const engine = new CommissionEngine(TEST_PLAN);
    const reference = new ReferenceCalculator(TEST_PLAN);
    const ids = ["B2", "A10", "A2", "b1", "A1"];
    for (const id of ids) {
      const deal: DealInput = {
        externalId: id,
        amountCents: "700000",
        closeDate: "01/10/2026",
        dealType: "NEW_BUSINESS",
      };
      engine.upsertDeal(deal);
      reference.upsertDeal(deal);
    }
    for (const id of ids) {
      expect(engine.explainDeal(id)).toEqual(reference.explainDeal(id));
    }
    // ASCII 序：A1 < A10 < A2 < B2 < b1
    expect(engine.explainDeal("A1").priorAccumulatedCents).toBe("0");
    expect(engine.explainDeal("A10").priorAccumulatedCents).toBe("700000");
    expect(engine.explainDeal("A2").priorAccumulatedCents).toBe("1400000");
    expect(engine.explainDeal("B2").priorAccumulatedCents).toBe("2100000");
    expect(engine.explainDeal("b1").priorAccumulatedCents).toBe("2800000");
  });

  it("version switch keeps accumulation from older deals", () => {
    const engine = new CommissionEngine(TEST_PLAN);
    const reference = new ReferenceCalculator(TEST_PLAN);
    const deals: DealInput[] = [
      { externalId: "OLD1", amountCents: "6000000", closeDate: "01/05/2026", dealType: "NEW_BUSINESS" },
      { externalId: "OLD2", amountCents: "4000000", closeDate: "02/01/2026", dealType: "RENEWAL" },
      { externalId: "NEW1", amountCents: "1000000", closeDate: "03/01/2026", dealType: "NEW_BUSINESS" },
    ];
    for (const deal of deals) {
      engine.upsertDeal(deal);
      reference.upsertDeal(deal);
    }
    const explanation = engine.explainDeal("NEW1");
    expect(explanation).toEqual(reference.explainDeal("NEW1"));
    // 累计跨版本延续：6000000 + 4000000
    expect(explanation.priorAccumulatedCents).toBe("10000000");
    expect(explanation.planVersionId).toBe("plan-v2");
    // 1000 万累计处直接命中 v2 第三档（>=10000000, 1600bps）
    expect(explanation.slices).toEqual([
      { fromCents: "10000000", toCents: "11000000", amountCents: "1000000", rateBps: 1600 },
    ]);
  });
});

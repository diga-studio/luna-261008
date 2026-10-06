import assert from "node:assert/strict";
import test from "node:test";
import { CommissionEngine } from "../src/engine.js";
import type { Deal, DealExplanation, PlanVersion } from "../src/types.js";
import { referenceExplain } from "./reference.js";

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

const PLAN_VERSIONS: readonly PlanVersion[] = [
  {
    id: "plan-jan",
    startDate: "01/01/2026",
    endDate: "01/31/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 500 },
      { thresholdCents: "100000", rateBps: 750 },
      { thresholdCents: "500000", rateBps: 1000 },
      { thresholdCents: "2000000", rateBps: 1250 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 250 },
      { thresholdCents: "300000", rateBps: 400 },
    ],
  },
  {
    id: "plan-feb",
    startDate: "02/01/2026",
    endDate: "02/28/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 600 },
      { thresholdCents: "150000", rateBps: 900 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 300 },
      { thresholdCents: "100000", rateBps: 450 },
      { thresholdCents: "800000", rateBps: 700 },
    ],
  },
  {
    id: "plan-mar",
    startDate: "03/01/2026",
    endDate: "03/31/2026",
    newBusinessTiers: [{ thresholdCents: "0", rateBps: 1000 }],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 200 },
      { thresholdCents: "50000", rateBps: 350 },
      { thresholdCents: "250000", rateBps: 500 },
      { thresholdCents: "1000000", rateBps: 650 },
    ],
  },
];

// 日期集中在少数几天（含版本边界），以制造大量同日 tie 与版本切换场景。
const DATES = [
  "01/05/2026",
  "01/31/2026",
  "01/31/2026",
  "02/01/2026",
  "02/14/2026",
  "02/28/2026",
  "03/01/2026",
  "03/15/2026",
  "03/31/2026",
];

function assertExplanationEqual(actual: DealExplanation, expected: DealExplanation): void {
  assert.equal(actual.externalId, expected.externalId, "externalId");
  assert.equal(actual.priorCumulativeCents, expected.priorCumulativeCents, "priorCumulativeCents");
  assert.equal(actual.planVersionId, expected.planVersionId, "planVersionId");
  assert.equal(actual.slices.length, expected.slices.length, "slices.length");
  for (let i = 0; i < actual.slices.length; i += 1) {
    const a = actual.slices[i];
    const e = expected.slices[i];
    assert.equal(a.fromCumulativeCents, e.fromCumulativeCents, `slices[${i}].fromCumulativeCents`);
    assert.equal(a.toCumulativeCents, e.toCumulativeCents, `slices[${i}].toCumulativeCents`);
    assert.equal(a.amountCents, e.amountCents, `slices[${i}].amountCents`);
    assert.equal(a.rateBps, e.rateBps, `slices[${i}].rateBps`);
  }
  assert.equal(actual.payableCents, expected.payableCents, "payableCents");
}

test("randomized interleaved upsert/remove matches full-sort reference", () => {
  const rand = mulberry32(20260331);
  const engine = new CommissionEngine(PLAN_VERSIONS);
  const mirror = new Map<string, Deal>();
  const idPool = Array.from({ length: 120 }, (_, i) => `D${i}`);

  const randomAmount = (): string => {
    const r = rand();
    if (r < 0.6) return String(Math.floor(rand() * 600000));
    if (r < 0.9) return String(Math.floor(rand() * 3000000));
    return (BigInt("9007199254740993") + BigInt(Math.floor(rand() * 1000000))).toString();
  };
  const randomDeal = (externalId: string): Deal => ({
    externalId,
    amountCents: randomAmount(),
    closeDate: DATES[Math.floor(rand() * DATES.length)],
    dealType: rand() < 0.5 ? "newBusiness" : "renewal",
  });
  const pickExistingId = (): string => {
    const ids = [...mirror.keys()];
    return ids[Math.floor(rand() * ids.length)];
  };

  for (let op = 0; op < 4000; op += 1) {
    const roll = rand();
    const freeIds = idPool.filter((id) => !mirror.has(id));
    if (roll < 0.45 && freeIds.length > 0) {
      const id = freeIds[Math.floor(rand() * freeIds.length)];
      const deal = randomDeal(id);
      engine.upsertDeal(deal);
      mirror.set(id, deal);
    } else if (roll < 0.75 && mirror.size > 0) {
      const id = pickExistingId();
      const deal = randomDeal(id);
      engine.upsertDeal(deal);
      mirror.set(id, deal);
    } else if (roll < 0.9 && mirror.size > 0) {
      const id = pickExistingId();
      engine.removeDeal(id);
      mirror.delete(id);
    } else if (mirror.size > 0) {
      const id = pickExistingId();
      assertExplanationEqual(engine.explainDeal(id), referenceExplain(mirror, PLAN_VERSIONS, id));
    }
  }

  for (const id of mirror.keys()) {
    assertExplanationEqual(engine.explainDeal(id), referenceExplain(mirror, PLAN_VERSIONS, id));
  }
});

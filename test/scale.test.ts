import { describe, expect, it } from "vitest";
import { CommissionEngine } from "../src/engine.js";
import type { DealInput, PlanVersion } from "../src/types.js";
import { ReferenceCalculator } from "./reference.js";

const SCALE_PLAN: PlanVersion[] = [
  {
    id: "scale-v1",
    effectiveFrom: "01/01/2026",
    effectiveTo: "03/31/2026",
    newBusinessTiers: [
      { thresholdCents: "0", rateBps: 500 },
      { thresholdCents: "100000000", rateBps: 1000 },
      { thresholdCents: "500000000", rateBps: 1500 },
      { thresholdCents: "2000000000", rateBps: 2000 },
    ],
    renewalTiers: [
      { thresholdCents: "0", rateBps: 300 },
      { thresholdCents: "200000000", rateBps: 800 },
    ],
  },
];

const DEAL_COUNT = 200_000;
const REVISION_COUNT = 2_000;

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

function dealId(index: number): string {
  return `D${String(index).padStart(9, "0")}`;
}

describe("scale test: 200k same-day deals + 2000 revisions", () => {
  it(
    "load, revise, query with timing",
    () => {
      const engine = new CommissionEngine(SCALE_PLAN);

      // 装载：20 万笔同日成交，externalId 按升序输入。
      const loadStart = performance.now();
      for (let i = 0; i < DEAL_COUNT; i += 1) {
        engine.upsertDeal({
          externalId: dealId(i),
          amountCents: String(100_000 + (i % 10_000)),
          closeDate: "02/10/2026",
          dealType: i % 3 === 0 ? "RENEWAL" : "NEW_BUSINESS",
        });
      }
      const loadMs = performance.now() - loadStart;
      expect(engine.dealCount).toBe(DEAL_COUNT);

      // 交错执行 2000 次早期修订（改金额/日期/类型、删除、补录）与末端查询。
      const rand = mulberry32(42);
      const reviseStart = performance.now();
      let queryMs = 0;
      let queries = 0;
      const lastId = dealId(DEAL_COUNT - 1);
      const lateIds: string[] = [];
      for (let r = 0; r < REVISION_COUNT; r += 1) {
        const roll = rand();
        if (roll < 0.4) {
          // 修改一笔早期成交（头部 1% 内）。
          const index = Math.floor(rand() * DEAL_COUNT * 0.01);
          engine.upsertDeal({
            externalId: dealId(index),
            amountCents: String(1 + Math.floor(rand() * 5_000_000)),
            closeDate: "01/05/2026",
            dealType: rand() < 0.5 ? "NEW_BUSINESS" : "RENEWAL",
          });
        } else if (roll < 0.7) {
          // 删除一笔早期成交。
          const index = Math.floor(rand() * DEAL_COUNT * 0.01);
          const id = dealId(index);
          try {
            engine.removeDeal(id);
          } catch {
            // 已被删除，忽略。
          }
        } else {
          // 乱序补录新成交。
          const id = `LATE${r}`;
          lateIds.push(id);
          engine.upsertDeal({
            externalId: id,
            amountCents: String(1 + Math.floor(rand() * 5_000_000)),
            closeDate: "01/20/2026",
            dealType: "NEW_BUSINESS",
          });
        }
        // 末端查询：始终解释按排序位于末尾的成交（不消耗随机数，便于参考侧重放）。
        const queryStart = performance.now();
        const queryId =
          lateIds.length === 0 || r % 2 === 0
            ? lastId
            : lateIds[r % lateIds.length]!;
        engine.explainDeal(queryId);
        queryMs += performance.now() - queryStart;
        queries += 1;
      }
      const reviseMs = performance.now() - reviseStart - queryMs;

      // 校验修订后的结果：抽样与全量排序参考计算器逐字段比较。
      const reference = new ReferenceCalculator(SCALE_PLAN);
      for (let i = 0; i < DEAL_COUNT; i += 1) {
        reference.upsertDeal({
          externalId: dealId(i),
          amountCents: String(100_000 + (i % 10_000)),
          closeDate: "02/10/2026",
          dealType: i % 3 === 0 ? "RENEWAL" : "NEW_BUSINESS",
        });
      }
      // 参考侧重放同样的修订序列。
      const replay = mulberry32(42);
      const sampler = mulberry32(7);
      const sampled: string[] = [];
      for (let r = 0; r < REVISION_COUNT; r += 1) {
        const roll = replay();
        if (roll < 0.4) {
          const index = Math.floor(replay() * DEAL_COUNT * 0.01);
          const deal: DealInput = {
            externalId: dealId(index),
            amountCents: String(1 + Math.floor(replay() * 5_000_000)),
            closeDate: "01/05/2026",
            dealType: replay() < 0.5 ? "NEW_BUSINESS" : "RENEWAL",
          };
          reference.upsertDeal(deal);
        } else if (roll < 0.7) {
          const index = Math.floor(replay() * DEAL_COUNT * 0.01);
          reference.removeDeal(dealId(index));
        } else {
          reference.upsertDeal({
            externalId: `LATE${r}`,
            amountCents: String(1 + Math.floor(replay() * 5_000_000)),
            closeDate: "01/20/2026",
            dealType: "NEW_BUSINESS",
          });
        }
        if (r % 200 === 0) sampled.push(dealId(Math.floor(sampler() * DEAL_COUNT)));
      }
      for (const id of sampled) {
        expect(engine.explainDeal(id)).toEqual(reference.explainDeal(id));
      }

      console.log(
        [
          `load ${DEAL_COUNT} deals: ${loadMs.toFixed(1)}ms`,
          `(${((loadMs * 1000) / DEAL_COUNT).toFixed(2)}us/op)`,
          `| ${REVISION_COUNT} revisions: ${reviseMs.toFixed(1)}ms`,
          `(${((reviseMs * 1000) / REVISION_COUNT).toFixed(2)}us/op)`,
          `| ${queries} tail queries: ${queryMs.toFixed(1)}ms`,
          `(${((queryMs * 1000) / queries).toFixed(2)}us/op)`,
        ].join(" "),
      );
    },
    120_000,
  );
});

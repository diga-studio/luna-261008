import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LeadPulse,
  DAY_MS,
  EVENT_TYPES,
  type BehaviorEvent,
  type EventType,
  type Weights,
} from "../src/index.js";

const T0 = 1_700_000_000_000; // fixed base time (unix ms)

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

function makeEvent(
  id: string,
  leadId: string,
  type: EventType,
  occurredAt: number,
): BehaviorEvent {
  return { id, leadId, type, occurredAt };
}

interface NaiveBand {
  count: number;
  contribution: number;
}

interface NaiveType {
  within30d: NaiveBand;
  between30And90d: NaiveBand;
  over90d: NaiveBand;
  contribution: number;
}

function naiveScore(
  events: readonly BehaviorEvent[],
  leadId: string,
  queryAt: number,
  weights: Weights,
  companySize: number,
) {
  const breakdown = {} as Record<EventType, NaiveType>;
  for (const type of EVENT_TYPES) {
    breakdown[type] = {
      within30d: { count: 0, contribution: 0 },
      between30And90d: { count: 0, contribution: 0 },
      over90d: { count: 0, contribution: 0 },
      contribution: 0,
    };
  }
  let behaviorHundredths = 0;
  for (const e of events) {
    if (e.leadId !== leadId || e.occurredAt > queryAt) continue;
    const age = queryAt - e.occurredAt;
    const pct = age <= 30 * DAY_MS ? 100 : age <= 90 * DAY_MS ? 75 : 40;
    const band =
      age <= 30 * DAY_MS
        ? "within30d"
        : age <= 90 * DAY_MS
          ? "between30And90d"
          : "over90d";
    const hundredths = weights[e.type] * pct;
    const entry = breakdown[e.type];
    entry[band].count += 1;
    entry[band].contribution += hundredths / 100;
    entry.contribution += hundredths / 100;
    behaviorHundredths += hundredths;
  }
  const company =
    companySize <= 50 ? 10 : companySize <= 200 ? 20 : companySize <= 1000 ? 35 : 50;
  const total = company + behaviorHundredths / 100;
  return {
    companyScore: company,
    behaviorScore: behaviorHundredths / 100,
    totalScore: total,
    score: Math.min(100, Math.max(0, total)),
    breakdown,
  };
}

function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function assertScoreMatchesNaive(
  actual: ReturnType<LeadPulse["scoreAt"]>,
  expected: ReturnType<typeof naiveScore>,
): void {
  assert.equal(actual.companyScore, expected.companyScore, "companyScore");
  assertClose(actual.behaviorScore, expected.behaviorScore, "behaviorScore");
  assertClose(actual.totalScore, expected.totalScore, "totalScore");
  assertClose(actual.score, expected.score, "score");
  for (const type of EVENT_TYPES) {
    for (const band of ["within30d", "between30And90d", "over90d"] as const) {
      assert.equal(
        actual.breakdown[type][band].count,
        expected.breakdown[type][band].count,
        `${type}.${band}.count`,
      );
      assertClose(
        actual.breakdown[type][band].contribution,
        expected.breakdown[type][band].contribution,
        `${type}.${band}.contribution`,
      );
    }
    assertClose(
      actual.breakdown[type].contribution,
      expected.breakdown[type].contribution,
      `${type}.contribution`,
    );
  }
}

test("company size tiers contribute fixed non-decaying scores", () => {
  const lp = new LeadPulse();
  const cases: Array<[number, number]> = [
    [1, 10],
    [50, 10],
    [51, 20],
    [200, 20],
    [201, 35],
    [1000, 35],
    [1001, 50],
    [100000, 50],
  ];
  cases.forEach(([size, expected], i) => {
    const leadId = `lead-${i}`;
    lp.registerLead(leadId, size);
    const result = lp.scoreAt(leadId, T0);
    assert.equal(result.companyScore, expected);
    assert.equal(result.totalScore, expected);
    assert.equal(result.score, expected);
  });
});

test("decay boundaries: exactly 30d keeps full weight, 30d+1ms drops to 75%", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  lp.ingestEvent(makeEvent("e1", "a", "webinar_attend", T0));

  const at30d = lp.scoreAt("a", T0 + 30 * DAY_MS);
  assert.equal(at30d.breakdown.webinar_attend.within30d.count, 1);
  assert.equal(at30d.breakdown.webinar_attend.within30d.contribution, 20);
  assert.equal(at30d.breakdown.webinar_attend.between30And90d.count, 0);

  const at30dPlus = lp.scoreAt("a", T0 + 30 * DAY_MS + 1);
  assert.equal(at30dPlus.breakdown.webinar_attend.within30d.count, 0);
  assert.equal(at30dPlus.breakdown.webinar_attend.between30And90d.count, 1);
  assert.equal(at30dPlus.breakdown.webinar_attend.between30And90d.contribution, 15);
});

test("decay boundaries: exactly 90d keeps 75%, 90d+1ms drops to 40%", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  lp.ingestEvent(makeEvent("e1", "a", "demo_request", T0));

  const at90d = lp.scoreAt("a", T0 + 90 * DAY_MS);
  assert.equal(at90d.breakdown.demo_request.between30And90d.count, 1);
  assert.equal(at90d.breakdown.demo_request.between30And90d.contribution, 22.5);
  assert.equal(at90d.breakdown.demo_request.over90d.count, 0);

  const at90dPlus = lp.scoreAt("a", T0 + 90 * DAY_MS + 1);
  assert.equal(at90dPlus.breakdown.demo_request.between30And90d.count, 0);
  assert.equal(at90dPlus.breakdown.demo_request.over90d.count, 1);
  assert.equal(at90dPlus.breakdown.demo_request.over90d.contribution, 12);
});

test("events at query time are included, later events excluded", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  lp.ingestEvent(makeEvent("now", "a", "pricing_view", T0));
  lp.ingestEvent(makeEvent("future", "a", "pricing_view", T0 + 1));
  const result = lp.scoreAt("a", T0);
  assert.equal(result.breakdown.pricing_view.within30d.count, 1);
  const later = lp.scoreAt("a", T0 + 1);
  assert.equal(later.breakdown.pricing_view.within30d.count, 2);
});

test("duplicate delivery by stable id counts once; same content with different ids counts separately", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  const event = makeEvent("dup", "a", "whitepaper_download", T0);
  assert.equal(lp.ingestEvent(event), true);
  assert.equal(lp.ingestEvent({ ...event }), false);
  assert.equal(lp.ingestEvent({ ...event }), false);
  assert.equal(
    lp.ingestEvent(makeEvent("other-id", "a", "whitepaper_download", T0)),
    true,
  );
  const result = lp.scoreAt("a", T0);
  assert.equal(result.breakdown.whitepaper_download.within30d.count, 2);
  assert.equal(result.breakdown.whitepaper_download.contribution, 20);
});

test("late-arriving event immediately affects queries of past moments", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  lp.ingestEvent(makeEvent("e1", "a", "pricing_view", T0));
  const before = lp.scoreAt("a", T0 + 10 * DAY_MS);
  assert.equal(before.breakdown.pricing_view.within30d.count, 1);
  // late event with old occurredAt arrives after the query
  lp.ingestEvent(makeEvent("late", "a", "pricing_view", T0 + 5 * DAY_MS));
  const after = lp.scoreAt("a", T0 + 10 * DAY_MS);
  assert.equal(after.breakdown.pricing_view.within30d.count, 2);
  assert.equal(after.breakdown.pricing_view.contribution, 30);
});

test("latest weights apply to historical queries without rule versioning", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  lp.ingestEvent(makeEvent("e1", "a", "demo_request", T0));
  const before = lp.scoreAt("a", T0);
  assert.equal(before.breakdown.demo_request.contribution, 30);
  lp.setWeights({ demo_request: 55 });
  const after = lp.scoreAt("a", T0);
  assert.equal(after.breakdown.demo_request.contribution, 55);
  lp.setWeights({ demo_request: 0 });
  const zeroed = lp.scoreAt("a", T0);
  assert.equal(zeroed.breakdown.demo_request.contribution, 0);
  assert.equal(zeroed.breakdown.demo_request.within30d.count, 1);
});

test("score above 100 decays below 100 with no new events; unclamped totals stay correct", () => {
  const lp = new LeadPulse();
  lp.registerLead("hot", 2000); // company score 50
  for (let i = 0; i < 4; i++) {
    lp.ingestEvent(makeEvent(`demo-${i}`, "hot", "demo_request", T0));
  }
  const fresh = lp.scoreAt("hot", T0);
  assert.equal(fresh.totalScore, 50 + 120);
  assert.equal(fresh.score, 100);
  assert.equal(fresh.breakdown.demo_request.within30d.count, 4);
  assert.equal(fresh.breakdown.demo_request.contribution, 120);

  const aged = lp.scoreAt("hot", T0 + 91 * DAY_MS);
  assert.equal(aged.breakdown.demo_request.over90d.count, 4);
  assert.equal(aged.breakdown.demo_request.contribution, 48);
  assert.equal(aged.totalScore, 98);
  assert.equal(aged.score, 98);
});

test("out-of-order, duplicate and reweighted stream matches naive per-event model", () => {
  const rand = mulberry32(42);
  const lp = new LeadPulse();
  const leads = ["l1", "l2", "l3"];
  const sizes = [30, 500, 5000];
  leads.forEach((id, i) => lp.registerLead(id, sizes[i]!));

  const accepted: BehaviorEvent[] = [];
  const span = 200 * DAY_MS;
  let nextId = 0;
  const totalEvents = 3000;
  for (let i = 0; i < totalEvents; i++) {
    const leadId = leads[Math.floor(rand() * leads.length)]!;
    const type = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!;
    const occurredAt = T0 - Math.floor(rand() * span);
    const event = makeEvent(`evt-${nextId++}`, leadId, type, occurredAt);
    if (lp.ingestEvent(event)) accepted.push(event);
    // ~10% duplicate redelivery of a random prior event
    if (accepted.length > 0 && rand() < 0.1) {
      const dup = accepted[Math.floor(rand() * accepted.length)]!;
      assert.equal(lp.ingestEvent({ ...dup }), false);
    }
    // occasional weight changes interleaved with writes
    if (i % 300 === 299) {
      lp.setWeights({
        [EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!]: Math.floor(
          rand() * 101,
        ),
      });
    }
  }

  const weights = lp.getWeights();
  for (let q = 0; q < 200; q++) {
    const leadId = leads[Math.floor(rand() * leads.length)]!;
    const queryAt = T0 - Math.floor(rand() * span) + Math.floor(rand() * span);
    const size = sizes[leads.indexOf(leadId)]!;
    assertScoreMatchesNaive(
      lp.scoreAt(leadId, queryAt),
      naiveScore(accepted, leadId, queryAt, weights, size),
    );
  }
});

test("weight changes between queries are reflected immediately", () => {
  const rand = mulberry32(7);
  const lp = new LeadPulse();
  lp.registerLead("a", 120);
  const accepted: BehaviorEvent[] = [];
  for (let i = 0; i < 500; i++) {
    const type = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!;
    const event = makeEvent(
      `e-${i}`,
      "a",
      type,
      T0 - Math.floor(rand() * 150 * DAY_MS),
    );
    lp.ingestEvent(event);
    accepted.push(event);
  }
  for (let round = 0; round < 20; round++) {
    const newWeights: Partial<Weights> = {};
    for (const type of EVENT_TYPES) {
      if (rand() < 0.5) newWeights[type] = Math.floor(rand() * 101);
    }
    lp.setWeights(newWeights);
    const queryAt = T0 - Math.floor(rand() * 150 * DAY_MS);
    assertScoreMatchesNaive(
      lp.scoreAt("a", queryAt),
      naiveScore(accepted, "a", queryAt, lp.getWeights(), 120),
    );
  }
});

test("validation: unknown lead, duplicate registration, bad weights, bad events", () => {
  const lp = new LeadPulse();
  lp.registerLead("a", 10);
  assert.throws(() => lp.registerLead("a", 20));
  assert.throws(() => lp.scoreAt("missing", T0));
  assert.throws(() =>
    lp.ingestEvent(makeEvent("x", "missing", "pricing_view", T0)),
  );
  assert.throws(() =>
    lp.ingestEvent(makeEvent("x", "a", "bogus" as EventType, T0)),
  );
  assert.throws(() => lp.setWeights({ pricing_view: 101 }));
  assert.throws(() => lp.setWeights({ pricing_view: -1 }));
  assert.throws(() => lp.setWeights({ pricing_view: 1.5 }));
  assert.throws(() => lp.setWeights({ nope: 10 } as Partial<Weights>));
});

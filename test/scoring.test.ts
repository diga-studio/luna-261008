import assert from 'node:assert/strict';
import { test } from './harness';
import {
  LeadPulse,
  DAY_MS,
  EVENT_TYPES,
  DECAY_FRESH,
  DECAY_MID,
  DECAY_OLD,
} from '../src/index';
import type { BehaviorEvent, EventType, ScoreResult } from '../src/index';

const T0 = 1_700_000_000_000; // 固定基准时刻

/** 确定性伪随机数生成器 */
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

function companyPointsOf(size: number): number {
  if (size <= 50) return 10;
  if (size <= 200) return 20;
  if (size <= 1000) return 35;
  return 50;
}

/** 逐事件独立计算的参考模型 */
function referenceScore(
  events: ReadonlyArray<BehaviorEvent>,
  weights: Record<EventType, number>,
  companySize: number,
  leadId: string,
  at: number,
): ScoreResult {
  const breakdown = {} as Record<
    EventType,
    { freshCount: number; midCount: number; oldCount: number; contribution: number }
  >;
  let behaviorTotal = 0;
  for (const type of EVENT_TYPES) {
    let fresh = 0;
    let mid = 0;
    let old = 0;
    for (const e of events) {
      if (e.leadId !== leadId || e.type !== type || e.occurredAt > at) {
        continue;
      }
      const age = at - e.occurredAt;
      if (age <= 30 * DAY_MS) {
        fresh += 1;
      } else if (age <= 90 * DAY_MS) {
        mid += 1;
      } else {
        old += 1;
      }
    }
    const exact =
      weights[type] *
      (fresh * DECAY_FRESH + mid * DECAY_MID + old * DECAY_OLD);
    behaviorTotal += exact;
    breakdown[type] = {
      freshCount: fresh,
      midCount: mid,
      oldCount: old,
      contribution: Math.round(exact * 100) / 100,
    };
  }
  const companyPoints = companyPointsOf(companySize);
  const unclampedExact = companyPoints + behaviorTotal;
  return {
    leadId,
    at,
    companyPoints,
    score: Math.round(Math.min(100, Math.max(0, unclampedExact)) * 100) / 100,
    unclampedTotal: Math.round(unclampedExact * 100) / 100,
    breakdown,
  };
}

function assertResultEqual(actual: ScoreResult, expected: ScoreResult): void {
  assert.equal(actual.companyPoints, expected.companyPoints, 'companyPoints');
  assert.equal(actual.score, expected.score, 'score');
  assert.equal(actual.unclampedTotal, expected.unclampedTotal, 'unclampedTotal');
  for (const type of EVENT_TYPES) {
    assert.deepEqual(
      actual.breakdown[type],
      expected.breakdown[type],
      `breakdown.${type}`,
    );
  }
}

test('公司人数分段贡献固定分数', () => {
  const engine = new LeadPulse();
  const sizes: Array<[number, number]> = [
    [1, 10],
    [50, 10],
    [51, 20],
    [200, 20],
    [201, 35],
    [1000, 35],
    [1001, 50],
    [100000, 50],
  ];
  for (let i = 0; i < sizes.length; i += 1) {
    const [size, points] = sizes[i] as [number, number];
    const leadId = `lead-${i}`;
    engine.registerLead(leadId, size);
    const r = engine.getScore(leadId, T0);
    assert.equal(r.companyPoints, points);
    assert.equal(r.score, points);
    assert.equal(r.unclampedTotal, points);
  }
});

test('恰好30日保留全部权重，多一毫秒降为75%', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10); // 公司分 10
  engine.recordEvent({ id: 'e1', leadId: 'a', occurredAt: T0, type: 'pricing_view' });

  const at30 = T0 + 30 * DAY_MS;
  const r1 = engine.getScore('a', at30);
  assert.equal(r1.breakdown.pricing_view.freshCount, 1);
  assert.equal(r1.breakdown.pricing_view.midCount, 0);
  assert.equal(r1.breakdown.pricing_view.contribution, 15);
  assert.equal(r1.unclampedTotal, 25);

  const r2 = engine.getScore('a', at30 + 1);
  assert.equal(r2.breakdown.pricing_view.freshCount, 0);
  assert.equal(r2.breakdown.pricing_view.midCount, 1);
  assert.equal(r2.breakdown.pricing_view.contribution, 11.25);
  assert.equal(r2.unclampedTotal, 21.25);
});

test('恰好90日保留75%，多一毫秒降为40%', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  engine.recordEvent({ id: 'e1', leadId: 'a', occurredAt: T0, type: 'demo_request' });

  const at90 = T0 + 90 * DAY_MS;
  const r1 = engine.getScore('a', at90);
  assert.equal(r1.breakdown.demo_request.midCount, 1);
  assert.equal(r1.breakdown.demo_request.oldCount, 0);
  assert.equal(r1.breakdown.demo_request.contribution, 22.5);
  assert.equal(r1.unclampedTotal, 32.5);

  const r2 = engine.getScore('a', at90 + 1);
  assert.equal(r2.breakdown.demo_request.midCount, 0);
  assert.equal(r2.breakdown.demo_request.oldCount, 1);
  assert.equal(r2.breakdown.demo_request.contribution, 12);
  assert.equal(r2.unclampedTotal, 22);
});

test('查询时刻之前未发生的事件不计入', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  engine.recordEvent({ id: 'e1', leadId: 'a', occurredAt: T0 + 1000, type: 'pricing_view' });
  const r = engine.getScore('a', T0 + 999);
  assert.equal(r.breakdown.pricing_view.freshCount, 0);
  assert.equal(r.unclampedTotal, 10);
  const r2 = engine.getScore('a', T0 + 1000);
  assert.equal(r2.breakdown.pricing_view.freshCount, 1);
});

test('相同编号重复投递只计一次，不同编号分别计入', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  const ev: BehaviorEvent = { id: 'e1', leadId: 'a', occurredAt: T0, type: 'webinar_attend' };
  assert.equal(engine.recordEvent(ev), true);
  assert.equal(engine.recordEvent(ev), false);
  assert.equal(engine.recordEvent({ ...ev }), false);
  assert.equal(
    engine.recordEvent({ id: 'e2', leadId: 'a', occurredAt: T0, type: 'webinar_attend' }),
    true,
  );
  const r = engine.getScore('a', T0);
  assert.equal(r.breakdown.webinar_attend.freshCount, 2);
  assert.equal(r.breakdown.webinar_attend.contribution, 40);
});

test('最终分数截断到100，未截断总分与贡献保留', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 5000); // 公司分 50
  for (let i = 0; i < 10; i += 1) {
    engine.recordEvent({ id: `e${i}`, leadId: 'a', occurredAt: T0, type: 'demo_request' });
  }
  const r = engine.getScore('a', T0);
  assert.equal(r.score, 100);
  assert.equal(r.unclampedTotal, 350); // 50 + 10*30
  assert.equal(r.breakdown.demo_request.contribution, 300);
});

test('超过100分的线索无新事件时衰减到100分以下，未截断贡献仍正确', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 50); // 公司分 10
  // 5 次申请演示：5*30 = 150，总分 160 > 100
  for (let i = 0; i < 5; i += 1) {
    engine.recordEvent({ id: `e${i}`, leadId: 'a', occurredAt: T0, type: 'demo_request' });
  }
  assert.equal(engine.getScore('a', T0).score, 100);
  assert.equal(engine.getScore('a', T0).unclampedTotal, 160);

  // 30 日后：150*0.75 = 112.5，仍超过 100
  const r1 = engine.getScore('a', T0 + 30 * DAY_MS + 1);
  assert.equal(r1.score, 100);
  assert.equal(r1.unclampedTotal, 122.5);
  assert.equal(r1.breakdown.demo_request.contribution, 112.5);

  // 90 日后：150*0.4 = 60，衰减到 100 以下
  const r2 = engine.getScore('a', T0 + 90 * DAY_MS + 1);
  assert.equal(r2.score, 70);
  assert.equal(r2.unclampedTotal, 70);
  assert.equal(r2.breakdown.demo_request.oldCount, 5);
  assert.equal(r2.breakdown.demo_request.contribution, 60);
});

test('调权立即生效，包括查询过去时刻', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  engine.recordEvent({ id: 'e1', leadId: 'a', occurredAt: T0, type: 'pricing_view' });
  assert.equal(engine.getScore('a', T0).breakdown.pricing_view.contribution, 15);
  engine.setWeight('pricing_view', 40);
  const r = engine.getScore('a', T0); // 查询过去时刻，使用新权重
  assert.equal(r.breakdown.pricing_view.contribution, 40);
  assert.equal(r.unclampedTotal, 50);
  engine.setWeight('pricing_view', 0);
  assert.equal(engine.getScore('a', T0).breakdown.pricing_view.contribution, 0);
});

test('非法输入校验', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  assert.throws(() => engine.registerLead('a', 20));
  assert.throws(() => engine.registerLead('b', 0));
  assert.throws(() => engine.setWeight('pricing_view', 101));
  assert.throws(() => engine.setWeight('pricing_view', -1));
  assert.throws(() => engine.setWeight('pricing_view', 1.5));
  assert.throws(() => engine.recordEvent({ id: 'x', leadId: 'ghost', occurredAt: T0, type: 'pricing_view' }));
  assert.throws(() => engine.getScore('ghost', T0));
});

test('乱序、重复投递与调权穿插后，历史查询与逐事件独立计算一致', () => {
  const rand = mulberry32(42);
  const engine = new LeadPulse();
  const leads: Array<{ id: string; size: number }> = [];
  for (let i = 0; i < 8; i += 1) {
    const size = [10, 50, 51, 200, 201, 1000, 1001, 7777][i] as number;
    const id = `lead-${i}`;
    engine.registerLead(id, size);
    leads.push({ id, size });
  }

  // 生成 400 个事件，时间散布在 200 天跨度内
  const span = 200 * DAY_MS;
  const events: BehaviorEvent[] = [];
  for (let i = 0; i < 400; i += 1) {
    const lead = leads[Math.floor(rand() * leads.length)] as { id: string; size: number };
    const type = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)] as EventType;
    events.push({
      id: `evt-${i}`,
      leadId: lead.id,
      occurredAt: T0 + Math.floor(rand() * span),
      type,
    });
  }
  // 乱序到达
  const shuffled = events.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = shuffled[i] as BehaviorEvent;
    shuffled[i] = shuffled[j] as BehaviorEvent;
    shuffled[j] = tmp;
  }

  const weights: Record<EventType, number> = {
    pricing_view: 15,
    whitepaper_download: 10,
    webinar_attend: 20,
    demo_request: 30,
  };

  const accepted: BehaviorEvent[] = [];

  const checkAll = () => {
    // 每个线索在若干历史时刻查询，与参考模型对比
    for (const lead of leads) {
      for (let k = 0; k < 4; k += 1) {
        const at = T0 + Math.floor(rand() * (span + 60 * DAY_MS));
        assertResultEqual(
          engine.getScore(lead.id, at),
          referenceScore(accepted, weights, lead.size, lead.id, at),
        );
      }
    }
  };

  // 穿插：部分写入 -> 重复投递 -> 调权 -> 再写入，每阶段后校验
  const third = Math.floor(shuffled.length / 3);
  for (const e of shuffled.slice(0, third)) {
    engine.recordEvent(e);
    accepted.push(e);
  }
  checkAll();

  // 重复投递已接收与未接收的事件
  for (const e of shuffled.slice(0, third)) {
    assert.equal(engine.recordEvent({ ...e }), false);
  }
  checkAll();

  // 调权
  weights.pricing_view = 0;
  weights.demo_request = 100;
  engine.setWeight('pricing_view', 0);
  engine.setWeight('demo_request', 100);
  checkAll();

  for (const e of shuffled.slice(third, third * 2)) {
    engine.recordEvent(e);
    accepted.push(e);
  }
  weights.whitepaper_download = 7;
  engine.setWeight('whitepaper_download', 7);
  checkAll();

  for (const e of shuffled.slice(third * 2)) {
    engine.recordEvent(e);
    accepted.push(e);
  }
  weights.webinar_attend = 55;
  engine.setWeight('webinar_attend', 55);
  checkAll();
});

test('迟到事件立即影响之后对历史时刻的查询', () => {
  const engine = new LeadPulse();
  engine.registerLead('a', 10);
  engine.recordEvent({ id: 'late-1', leadId: 'a', occurredAt: T0, type: 'demo_request' });
  const queryAt = T0 + 10 * DAY_MS;
  assert.equal(engine.getScore('a', queryAt).breakdown.demo_request.freshCount, 1);
  // 再补一个更早的迟到事件
  engine.recordEvent({ id: 'late-2', leadId: 'a', occurredAt: T0 - 80 * DAY_MS, type: 'demo_request' });
  const r = engine.getScore('a', queryAt);
  assert.equal(r.breakdown.demo_request.freshCount, 1);
  assert.equal(r.breakdown.demo_request.midCount, 1); // 年龄 80+10=90 天？80 天前发生，查询时年龄 90 天 -> mid
  assert.equal(r.unclampedTotal, 10 + 30 + 22.5);
});

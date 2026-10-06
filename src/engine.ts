import {
  EVENT_TYPES,
  FRESH_LIMIT_MS,
  MID_LIMIT_MS,
  DECAY_FRESH,
  DECAY_MID,
  DECAY_OLD,
} from './types';
import type {
  BehaviorEvent,
  EventType,
  ScoreResult,
  TypeBreakdown,
} from './types';

/** pending 缓冲超过该长度就归并进有序主数组 */
const MERGE_THRESHOLD = 1024;

const DEFAULT_WEIGHTS: Record<EventType, number> = {
  pricing_view: 15,
  whitepaper_download: 10,
  webinar_attend: 20,
  demo_request: 30,
};

/** 第一个 >= x 的下标 */
function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 第一个 > x 的下标 */
function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) <= x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 某一线索某一类型的事件时间序列：有序主数组 + 小的待归并缓冲 */
class EventSeries {
  private main: number[] = [];
  private pending: number[] = [];

  add(time: number): void {
    this.pending.push(time);
    if (this.pending.length > MERGE_THRESHOLD) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.pending.length === 0) {
      return;
    }
    this.pending.sort((a, b) => a - b);
    const merged = new Array<number>(this.main.length + this.pending.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < this.main.length && j < this.pending.length) {
      if ((this.main[i] as number) <= (this.pending[j] as number)) {
        merged[k++] = this.main[i++] as number;
      } else {
        merged[k++] = this.pending[j++] as number;
      }
    }
    while (i < this.main.length) {
      merged[k++] = this.main[i++] as number;
    }
    while (j < this.pending.length) {
      merged[k++] = this.pending[j++] as number;
    }
    this.main = merged;
    this.pending = [];
  }

  /**
   * 统计发生时间 <= at 的事件在三个年龄段的数量。
   * fresh: [freshStart, at]；mid: [midStart, freshStart)；old: (-inf, midStart)
   */
  countBands(
    at: number,
    freshStart: number,
    midStart: number,
  ): [number, number, number] {
    const leAt = upperBound(this.main, at);
    const ltFresh = lowerBound(this.main, freshStart);
    const ltMid = lowerBound(this.main, midStart);
    let fresh = leAt - ltFresh;
    let mid = ltFresh - ltMid;
    let old = ltMid;
    for (const t of this.pending) {
      if (t > at) {
        continue;
      }
      if (t >= freshStart) {
        fresh += 1;
      } else if (t >= midStart) {
        mid += 1;
      } else {
        old += 1;
      }
    }
    return [fresh, mid, old];
  }
}

interface LeadRecord {
  companyPoints: number;
  series: Record<EventType, EventSeries>;
}

function companySizePoints(companySize: number): number {
  if (companySize <= 50) {
    return 10;
  }
  if (companySize <= 200) {
    return 20;
  }
  if (companySize <= 1000) {
    return 35;
  }
  return 50;
}

/**
 * LeadPulse 时效评分引擎。
 * 数据只保存在进程内存，所有调用顺序执行。
 */
export class LeadPulse {
  private readonly leads = new Map<string, LeadRecord>();
  private readonly seenEventIds = new Set<string>();
  private readonly weights: Record<EventType, number> = { ...DEFAULT_WEIGHTS };

  /** 登记线索；公司人数登记后不变。重复登记抛出错误。 */
  registerLead(leadId: string, companySize: number): void {
    if (this.leads.has(leadId)) {
      throw new Error(`lead already registered: ${leadId}`);
    }
    if (!Number.isFinite(companySize) || companySize < 1) {
      throw new Error(`invalid company size: ${companySize}`);
    }
    const series = {} as Record<EventType, EventSeries>;
    for (const type of EVENT_TYPES) {
      series[type] = new EventSeries();
    }
    this.leads.set(leadId, {
      companyPoints: companySizePoints(companySize),
      series,
    });
  }

  /** 接收行为事件；返回 false 表示相同编号的重复投递，已忽略。 */
  recordEvent(event: BehaviorEvent): boolean {
    if (this.seenEventIds.has(event.id)) {
      return false;
    }
    const lead = this.leads.get(event.leadId);
    if (!lead) {
      throw new Error(`unknown lead: ${event.leadId}`);
    }
    const series = lead.series[event.type];
    if (!series) {
      throw new Error(`unknown event type: ${String(event.type)}`);
    }
    if (!Number.isFinite(event.occurredAt)) {
      throw new Error(`invalid occurredAt: ${event.occurredAt}`);
    }
    this.seenEventIds.add(event.id);
    series.add(event.occurredAt);
    return true;
  }

  /** 调整某类事件权重（0 至 100 的整数），立即生效于之后的所有查询。 */
  setWeight(type: EventType, weight: number): void {
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw new Error(`invalid weight: ${weight}`);
    }
    if (!(type in this.weights)) {
      throw new Error(`unknown event type: ${String(type)}`);
    }
    this.weights[type] = weight;
  }

  /** 查询指定时刻评分；使用调用时最新权重。 */
  getScore(leadId: string, at: number): ScoreResult {
    const lead = this.leads.get(leadId);
    if (!lead) {
      throw new Error(`unknown lead: ${leadId}`);
    }
    const freshStart = at - FRESH_LIMIT_MS;
    const midStart = at - MID_LIMIT_MS;

    const breakdown = {} as Record<EventType, TypeBreakdown>;
    let behaviorTotal = 0;
    for (const type of EVENT_TYPES) {
      const [freshCount, midCount, oldCount] = lead.series[type].countBands(
        at,
        freshStart,
        midStart,
      );
      const weight = this.weights[type];
      const exact =
        weight *
        (freshCount * DECAY_FRESH + midCount * DECAY_MID + oldCount * DECAY_OLD);
      behaviorTotal += exact;
      breakdown[type] = {
        freshCount,
        midCount,
        oldCount,
        contribution: round2(exact),
      };
    }

    const unclampedExact = lead.companyPoints + behaviorTotal;
    const unclampedTotal = round2(unclampedExact);
    const score = round2(Math.min(100, Math.max(0, unclampedExact)));

    return {
      leadId,
      at,
      companyPoints: lead.companyPoints,
      score,
      unclampedTotal,
      breakdown,
    };
  }
}

/** 行为事件类型 */
export type EventType =
  | 'pricing_view'
  | 'whitepaper_download'
  | 'webinar_attend'
  | 'demo_request';

/** 全部行为类型（固定顺序） */
export const EVENT_TYPES: readonly EventType[] = [
  'pricing_view',
  'whitepaper_download',
  'webinar_attend',
  'demo_request',
];

/** 一日固定毫秒数 */
export const DAY_MS = 86_400_000;

/** 衰减档位边界（毫秒年龄） */
export const FRESH_LIMIT_MS = 30 * DAY_MS;
export const MID_LIMIT_MS = 90 * DAY_MS;

/** 各年龄段保留权重 */
export const DECAY_FRESH = 1;
export const DECAY_MID = 0.75;
export const DECAY_OLD = 0.4;

/** 行为事件 */
export interface BehaviorEvent {
  /** 稳定编号，相同编号只计一次 */
  id: string;
  /** 所属线索 */
  leadId: string;
  /** 发生时间，Unix 毫秒 */
  occurredAt: number;
  type: EventType;
}

/** 单个行为类型在指定查询时刻的分解 */
export interface TypeBreakdown {
  /** 年龄 ≤ 30 日的事件数 */
  freshCount: number;
  /** 30 日 < 年龄 ≤ 90 日的事件数 */
  midCount: number;
  /** 年龄 > 90 日的事件数 */
  oldCount: number;
  /** 该类型衰减后的贡献分（精确到 0.01） */
  contribution: number;
}

/** 指定时刻的评分结果 */
export interface ScoreResult {
  leadId: string;
  /** 查询时刻，Unix 毫秒 */
  at: number;
  /** 公司人数贡献（不衰减） */
  companyPoints: number;
  /** 最终分数，0 至 100 */
  score: number;
  /** 未截断总分（公司分 + 全部衰减后行为分，精确到 0.01） */
  unclampedTotal: number;
  /** 各行为类型分解 */
  breakdown: Record<EventType, TypeBreakdown>;
}

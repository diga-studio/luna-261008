export const EVENT_TYPES = [
  "pricing_view",
  "whitepaper_download",
  "webinar_attend",
  "demo_request",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface BehaviorEvent {
  readonly id: string;
  readonly leadId: string;
  readonly type: EventType;
  readonly occurredAt: number;
}

export type Weights = Record<EventType, number>;

export interface BandBreakdown {
  readonly count: number;
  readonly contribution: number;
}

export interface TypeBreakdown {
  readonly within30d: BandBreakdown;
  readonly between30And90d: BandBreakdown;
  readonly over90d: BandBreakdown;
  readonly contribution: number;
}

export interface ScoreBreakdown {
  readonly pricing_view: TypeBreakdown;
  readonly whitepaper_download: TypeBreakdown;
  readonly webinar_attend: TypeBreakdown;
  readonly demo_request: TypeBreakdown;
}

export interface ScoreResult {
  readonly leadId: string;
  readonly queryAt: number;
  readonly companyScore: number;
  readonly behaviorScore: number;
  readonly totalScore: number;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

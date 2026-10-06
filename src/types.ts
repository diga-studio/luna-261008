/** 代理标识，由调用方提供，需稳定。 */
export type AgentId = string;

/** 事件标识，由调用方提供，同一事件重试沿用同一标识。 */
export type EventId = string;

/** 代理侧分配给事件的序号，从 1 开始连续递增。 */
export type Seq = number;

/** 补传时代理发往汇总侧的事件信封。 */
export interface EventEnvelope {
  agentId: AgentId;
  eventId: EventId;
  seq: Seq;
  payload: Buffer;
}

/** 汇总侧返回给代理的确认（回执）。 */
export interface AckMessage {
  agentId: AgentId;
  /** 已连续确认到的事件序号（含），即连续前缀末尾。 */
  watermark: Seq;
}

/** 代理接收事件的结果。 */
export interface ReceiveResult {
  eventId: EventId;
  seq: Seq;
  /** true 表示本次为新事件；false 表示命中已有事件（幂等重试）。 */
  isNew: boolean;
}

/** 汇总侧公开的一条威胁记录。 */
export interface ThreatRecord {
  agentId: AgentId;
  eventId: EventId;
  seq: Seq;
  payload: Buffer;
}

/** 完整状态 */
export type IdentityStatus = "active" | "suspended" | "deprovisioned";

/** 权限变更记录 */
export interface ChangeRecord {
  kind: "change";
  seq: number;
  identity: string;
  /** 生效时间，整数毫秒 */
  effectiveTime: number;
  status: IdentityStatus;
  /** 准入权限 */
  allowEntry: boolean;
  /** 黑名单位 */
  blacklisted: boolean;
}

/** 封口记录：保证全部生效时间 <= time 的变更都位于它之前 */
export interface SealRecord {
  kind: "seal";
  seq: number;
  time: number;
}

export type AuthorityRecord = ChangeRecord | SealRecord;

/** 令牌：有效期左闭右开 [validFrom, validTo) */
export interface Token {
  identity: string;
  validFrom: number;
  validTo: number;
}

/** 入场时间闭区间 */
export interface TimeWindow {
  start: number;
  end: number;
}

/** 不可变缓存（由 makeCache 导出） */
export interface Cache {
  readonly boundary: number;
  readonly sealSeq: number;
  readonly timelines: Readonly<Record<string, readonly ChangeRecord[]>>;
}

/** 入场记录 */
export interface EntryEvent {
  id: string;
  token: Token;
  window: TimeWindow;
  /** checkOffline 的本地放行结果 */
  localAllowed: boolean;
}

/** checkOffline 的返回 */
export interface OfflineDecision {
  allowed: boolean;
  event: EntryEvent;
}

export type ReconcileVerdict = "allowed" | "denied" | "uncertain" | "pending";

/** reconcile 对单条入场记录的结论 */
export interface ReconcileResult {
  id: string;
  verdict: ReconcileVerdict;
  /** 本地已放行但最终为 denied */
  anomaly: boolean;
}

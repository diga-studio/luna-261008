/** 身份完整状态 */
export type IdentityStatus = "active" | "suspended" | "deprovisioned";

/** 权限变更记录：状态自 effectiveAt 起适用 */
export interface ChangeRecord {
  readonly kind: "change";
  readonly seq: number;
  readonly identity: string;
  /** 生效时间，整数毫秒 */
  readonly effectiveAt: number;
  readonly status: IdentityStatus;
  /** 准入权限 */
  readonly canEnter: boolean;
  /** 身份所属单位 */
  readonly unit: string;
  /** 黑名单位列表 */
  readonly blacklistedUnits: readonly string[];
}

/** 封口记录：保证全部 effectiveAt <= W 的变更都位于它之前 */
export interface SealRecord {
  readonly kind: "seal";
  readonly seq: number;
  /** 封口时间 W，整数毫秒 */
  readonly W: number;
}

export type AuthorityRecord = ChangeRecord | SealRecord;

/** 令牌：有效期左闭右开 [validFrom, validTo) */
export interface Token {
  readonly identity: string;
  readonly validFrom: number;
  readonly validTo: number;
}

/** 入场时间闭区间 [start, end] */
export interface TimeWindow {
  readonly start: number;
  readonly end: number;
}

/** 不可变缓存：最新完整封口对应的权限时间线快照 */
export interface AccessCache {
  /** 已知完整历史边界 W */
  readonly boundary: number;
  /** 每个身份按 effectiveAt 升序的变更时间线（同毫秒取最大 seq） */
  readonly timelines: ReadonlyMap<string, readonly ChangeRecord[]>;
}

/** 本地放行判定结果 */
export type LocalDecision = "allowed" | "denied";

/** 入场记录：checkOffline 的输出，后续 reconcile 的输入 */
export interface EntryRecord {
  readonly id: string;
  readonly identity: string;
  /** 判定所用令牌 */
  readonly token: Token;
  readonly window: TimeWindow;
  readonly decision: LocalDecision;
  /** 判定所用缓存的边界 */
  readonly cacheBoundary: number;
}

export interface CheckResult {
  readonly decision: LocalDecision;
  readonly entry: EntryRecord;
}

/** 最终结论 */
export type FinalConclusion = "allowed" | "denied" | "uncertain";

export interface ReconcileResult {
  readonly entryId: string;
  readonly identity: string;
  /** pending 表示窗口上界超过已知完整边界，暂无最终结论 */
  readonly status: "final" | "pending";
  readonly conclusion: FinalConclusion | null;
  /** 本地已放行但最终为 denied */
  readonly anomaly: boolean;
}

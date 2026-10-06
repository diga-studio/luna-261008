import type { AuthorityRecord, AccessCache, CheckResult, EntryRecord, ReconcileResult, TimeWindow, Token } from "./types.js";
export * from "./types.js";
export { buildTimeline, canEnterAt, verdictOverWindow } from "./history.js";
export interface AccessTracker {
    ingestAuthority(records: readonly AuthorityRecord[]): void;
    makeCache(): AccessCache;
    reconcile(events: readonly EntryRecord[]): ReconcileResult[];
}
export declare function createTracker(): AccessTracker;
/** 离线判定：只依据传入缓存，整个窗口都在令牌有效期内且缓存全程允许才放行 */
export declare function checkOffline(cache: AccessCache, token: Token, window: TimeWindow): CheckResult;

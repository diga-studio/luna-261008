import { randomUUID } from "node:crypto";
import { buildTimeline, verdictOverWindow, } from "./history.js";
export * from "./types.js";
export { buildTimeline, canEnterAt, verdictOverWindow } from "./history.js";
function freezeChange(change) {
    return Object.freeze({
        ...change,
        blacklistedUnits: Object.freeze([...change.blacklistedUnits]),
    });
}
function freezeRecord(record) {
    return record.kind === "change"
        ? freezeChange(record)
        : Object.freeze({ ...record });
}
export function createTracker() {
    /** seq -> 记录，同 seq 重复投递保留首份 */
    const records = new Map();
    /** identity -> 全部变更（未排序，未去重） */
    const changesByIdentity = new Map();
    /** 已定稿结论，entryId -> 结果，保证不翻转 */
    const finals = new Map();
    /** 连续前缀长度：seq 1..n 全部到齐 */
    function contiguousPrefix() {
        let n = 0;
        while (records.has(n + 1))
            n += 1;
        return n;
    }
    /** 已知完整边界：连续前缀内最大封口 W；无封口时为 -Infinity */
    function completeBoundary() {
        const prefix = contiguousPrefix();
        let boundary = Number.NEGATIVE_INFINITY;
        for (let seq = 1; seq <= prefix; seq += 1) {
            const record = records.get(seq);
            if (record !== undefined && record.kind === "seal" && record.W > boundary) {
                boundary = record.W;
            }
        }
        return { boundary, prefix };
    }
    /** 边界内、连续前缀内的变更构成的时间线 */
    function timelineUpTo(identity, boundary, prefix) {
        const all = changesByIdentity.get(identity) ?? [];
        const usable = all.filter((c) => c.seq <= prefix && c.effectiveAt <= boundary);
        return Object.freeze(buildTimeline(usable));
    }
    return {
        ingestAuthority(incoming) {
            for (const raw of incoming) {
                if (!Number.isInteger(raw.seq) || raw.seq < 1) {
                    throw new Error(`invalid seq: ${String(raw.seq)}`);
                }
                if (records.has(raw.seq))
                    continue;
                const record = freezeRecord(raw);
                records.set(record.seq, record);
                if (record.kind === "change") {
                    const list = changesByIdentity.get(record.identity);
                    if (list === undefined) {
                        changesByIdentity.set(record.identity, [record]);
                    }
                    else {
                        list.push(record);
                    }
                }
            }
        },
        makeCache() {
            const { boundary, prefix } = completeBoundary();
            const timelines = new Map();
            for (const identity of changesByIdentity.keys()) {
                timelines.set(identity, timelineUpTo(identity, boundary, prefix));
            }
            return Object.freeze({ boundary, timelines });
        },
        reconcile(events) {
            const { boundary, prefix } = completeBoundary();
            return events.map((entry) => {
                const memo = finals.get(entry.id);
                if (memo !== undefined)
                    return memo;
                if (entry.window.end > boundary) {
                    return {
                        entryId: entry.id,
                        identity: entry.identity,
                        status: "pending",
                        conclusion: null,
                        anomaly: false,
                    };
                }
                const timeline = timelineUpTo(entry.identity, boundary, prefix);
                const verdict = verdictOverWindow(timeline, entry.token, entry.window);
                const conclusion = verdict === "all-allowed"
                    ? "allowed"
                    : verdict === "all-denied"
                        ? "denied"
                        : "uncertain";
                const result = {
                    entryId: entry.id,
                    identity: entry.identity,
                    status: "final",
                    conclusion,
                    anomaly: entry.decision === "allowed" && conclusion === "denied",
                };
                finals.set(entry.id, result);
                return result;
            });
        },
    };
}
/** 离线判定：只依据传入缓存，整个窗口都在令牌有效期内且缓存全程允许才放行 */
export function checkOffline(cache, token, window) {
    const timeline = cache.timelines.get(token.identity) ?? [];
    const tokenCoversWindow = window.start >= token.validFrom && window.end < token.validTo;
    const allowed = tokenCoversWindow &&
        verdictOverWindow(timeline, token, window) === "all-allowed";
    const entry = {
        id: randomUUID(),
        identity: token.identity,
        token,
        window,
        decision: allowed ? "allowed" : "denied",
        cacheBoundary: cache.boundary,
    };
    return { decision: entry.decision, entry };
}

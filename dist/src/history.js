/** 同一身份同一毫秒取最大 seq，结果按 effectiveAt 升序 */
export function buildTimeline(changes) {
    const byMs = new Map();
    for (const change of changes) {
        const prev = byMs.get(change.effectiveAt);
        if (prev === undefined || change.seq > prev.seq) {
            byMs.set(change.effectiveAt, change);
        }
    }
    return [...byMs.values()].sort((a, b) => a.effectiveAt - b.effectiveAt);
}
/** 时刻 t 生效的变更；首次变更之前返回 undefined */
export function changeAt(timeline, t) {
    let lo = 0;
    let hi = timeline.length;
    let found;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const record = timeline[mid];
        if (record.effectiveAt <= t) {
            found = record;
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return found;
}
/** 单时刻准入：active + 有准入权限 + 所属单位不在黑名单 */
export function canEnterAt(timeline, t) {
    const change = changeAt(timeline, t);
    if (change === undefined)
        return false;
    return (change.status === "active" &&
        change.canEnter &&
        !change.blacklistedUnits.includes(change.unit));
}
function tokenValidAt(token, t) {
    return t >= token.validFrom && t < token.validTo;
}
/** 单时刻放行条件：权限允许且令牌在有效期内 */
export function admittedAt(timeline, token, t) {
    return canEnterAt(timeline, t) && tokenValidAt(token, t);
}
/**
 * 闭区间窗口上的放行结论。
 * 权限与令牌有效性都是右连续阶梯函数，
 * 只需采样窗口起点及窗口内全部跳变点。
 */
export function verdictOverWindow(timeline, token, window) {
    const points = [window.start];
    for (const change of timeline) {
        if (change.effectiveAt > window.end)
            break;
        if (change.effectiveAt > window.start)
            points.push(change.effectiveAt);
    }
    if (token.validFrom > window.start && token.validFrom <= window.end) {
        points.push(token.validFrom);
    }
    if (token.validTo > window.start && token.validTo <= window.end) {
        points.push(token.validTo);
    }
    let sawAllowed = false;
    let sawDenied = false;
    for (const t of points) {
        if (admittedAt(timeline, token, t)) {
            sawAllowed = true;
        }
        else {
            sawDenied = true;
        }
        if (sawAllowed && sawDenied)
            return "mixed";
    }
    return sawAllowed ? "all-allowed" : "all-denied";
}

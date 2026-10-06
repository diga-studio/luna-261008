import test from "node:test";
import assert from "node:assert/strict";
import { createTracker, checkOffline, } from "../src/index.js";
function change(seq, identity, effectiveAt, over = {}) {
    return {
        kind: "change",
        seq,
        identity,
        effectiveAt,
        status: "active",
        canEnter: true,
        unit: "u1",
        blacklistedUnits: [],
        ...over,
    };
}
function seal(seq, W) {
    return { kind: "seal", seq, W };
}
let entryCounter = 0;
function manualEntry(token, window, decision = "denied") {
    entryCounter += 1;
    return {
        id: `manual-${entryCounter}`,
        identity: token.identity,
        token,
        window,
        decision,
        cacheBoundary: 0,
    };
}
test("缓存放行后撤销再恢复：缺撤销时 pending，补齐后 denied，重复投递不改变结果", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([change(1, "alice", 100), seal(2, 200)]);
    const cache = tracker.makeCache();
    assert.equal(cache.boundary, 200);
    const token = { identity: "alice", validFrom: 0, validTo: 1000 };
    // 事件发生在即将到来的撤销期间 [250, 350)，但缓存只知道到 200 的历史
    const { decision, entry } = checkOffline(cache, token, { start: 260, end: 280 });
    assert.equal(decision, "allowed");
    // 先只收到恢复(seq4)和封口(seq5)，缺撤销(seq3)：边界仍停在 200
    tracker.ingestAuthority([change(4, "alice", 350), seal(5, 400)]);
    assert.equal(tracker.makeCache().boundary, 200);
    const [pending] = tracker.reconcile([entry]);
    assert.equal(pending.status, "pending");
    assert.equal(pending.conclusion, null);
    assert.equal(pending.anomaly, false);
    // 旧缓存不被后续同步改写
    assert.equal(cache.boundary, 200);
    assert.equal(checkOffline(cache, token, { start: 260, end: 280 }).decision, "allowed");
    // 补齐撤销，并重复投递同样的记录
    tracker.ingestAuthority([
        change(3, "alice", 250, { status: "suspended" }),
        change(3, "alice", 250, { status: "suspended" }),
        seal(5, 400),
    ]);
    assert.equal(tracker.makeCache().boundary, 400);
    const [final1] = tracker.reconcile([entry]);
    assert.equal(final1.status, "final");
    assert.equal(final1.conclusion, "denied");
    assert.equal(final1.anomaly, true);
    // 重复对账结论不翻转
    const [final2] = tracker.reconcile([entry]);
    assert.deepEqual(final2, final1);
});
test("窗口两端允许、中间暂停为 uncertain，且不算确定违规", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([
        change(1, "bob", 100),
        change(2, "bob", 300, { status: "suspended" }),
        change(3, "bob", 500),
        seal(4, 600),
    ]);
    const token = { identity: "bob", validFrom: 0, validTo: 1000 };
    const cache = tracker.makeCache();
    // 200 与 600 允许，中间 [300,500) 暂停
    const { entry } = checkOffline(cache, token, { start: 200, end: 600 });
    const [r] = tracker.reconcile([entry]);
    assert.equal(r.status, "final");
    assert.equal(r.conclusion, "uncertain");
    assert.equal(r.anomaly, false);
    // 全程允许与全程拒绝
    const [ok] = tracker.reconcile([manualEntry(token, { start: 100, end: 299 })]);
    assert.equal(ok.conclusion, "allowed");
    const [no] = tracker.reconcile([manualEntry(token, { start: 300, end: 499 })]);
    assert.equal(no.conclusion, "denied");
});
test("同一身份同毫秒多次变更取最大 seq", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([
        change(1, "carol", 700),
        change(2, "carol", 700, { status: "suspended" }),
        change(3, "dave", 800, { status: "suspended" }),
        change(4, "dave", 800),
        seal(5, 900),
    ]);
    const carol = { identity: "carol", validFrom: 0, validTo: 1000 };
    const dave = { identity: "dave", validFrom: 0, validTo: 1000 };
    const [c] = tracker.reconcile([manualEntry(carol, { start: 700, end: 700 })]);
    assert.equal(c.conclusion, "denied");
    const [d] = tracker.reconcile([manualEntry(dave, { start: 800, end: 800 })]);
    assert.equal(d.conclusion, "allowed");
});
test("令牌有效期左闭右开与单点窗口", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([change(1, "erin", 0), seal(2, 2000)]);
    const token = { identity: "erin", validFrom: 500, validTo: 1000 };
    const cache = tracker.makeCache();
    // 右端点 1000 不在有效期内
    assert.equal(checkOffline(cache, token, { start: 990, end: 1000 }).decision, "denied");
    assert.equal(checkOffline(cache, token, { start: 990, end: 999 }).decision, "allowed");
    // 左端点 500 在有效期内
    assert.equal(checkOffline(cache, token, { start: 500, end: 500 }).decision, "allowed");
    // 单点窗口落在右端点上：对账为 denied
    const [r] = tracker.reconcile([manualEntry(token, { start: 1000, end: 1000 })]);
    assert.equal(r.conclusion, "denied");
    // 令牌在窗口中途到期：混合，uncertain
    const [mid] = tracker.reconcile([manualEntry(token, { start: 900, end: 1500 })]);
    assert.equal(mid.conclusion, "uncertain");
});
test("准入条件：状态、权限、黑名单与首次变更之前", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([
        change(1, "frank", 100, { canEnter: false }),
        change(2, "gina", 100, { unit: "u2", blacklistedUnits: ["u2"] }),
        change(3, "henry", 100, { status: "deprovisioned" }),
        change(4, "ivan", 100, { unit: "u2", blacklistedUnits: ["u9"] }),
        seal(5, 500),
    ]);
    const cache = tracker.makeCache();
    const tok = (identity) => ({ identity, validFrom: 0, validTo: 1000 });
    const win = { start: 200, end: 200 };
    assert.equal(checkOffline(cache, tok("frank"), win).decision, "denied");
    assert.equal(checkOffline(cache, tok("gina"), win).decision, "denied");
    assert.equal(checkOffline(cache, tok("henry"), win).decision, "denied");
    assert.equal(checkOffline(cache, tok("ivan"), win).decision, "allowed");
    // 首次变更之前视为拒绝
    assert.equal(checkOffline(cache, tok("ivan"), { start: 50, end: 50 }).decision, "denied");
    // 从未出现的身份拒绝
    assert.equal(checkOffline(cache, tok("ghost"), win).decision, "denied");
});
test("乱序与重复导入得到相同缓存；结论不依赖投递顺序", () => {
    const records = [
        change(1, "judy", 100),
        change(2, "judy", 200, { status: "suspended" }),
        change(3, "judy", 400),
        seal(4, 450),
        change(5, "judy", 480, { status: "suspended" }),
        seal(6, 600),
    ];
    const ordered = createTracker();
    ordered.ingestAuthority(records);
    const shuffled = createTracker();
    shuffled.ingestAuthority([records[5], records[2], records[0]]);
    shuffled.ingestAuthority([records[3], records[1], records[4], records[0]]);
    const c1 = ordered.makeCache();
    const c2 = shuffled.makeCache();
    assert.equal(c1.boundary, 600);
    assert.equal(c2.boundary, 600);
    assert.deepEqual(c1.timelines.get("judy"), c2.timelines.get("judy"));
    const token = { identity: "judy", validFrom: 0, validTo: 1000 };
    const e1 = manualEntry(token, { start: 410, end: 470 });
    const e2 = manualEntry(token, { start: 410, end: 470 });
    const [r1] = ordered.reconcile([{ ...e1, id: "same" }]);
    const [r2] = shuffled.reconcile([{ ...e2, id: "same" }]);
    assert.deepEqual(r1, r2);
    assert.equal(r1.conclusion, "allowed");
});
test("缺号后的记录不得提前影响缓存与对账", () => {
    const tracker = createTracker();
    // 缺 seq2，后续记录不得生效
    tracker.ingestAuthority([
        change(1, "kate", 100),
        change(3, "kate", 200, { status: "suspended" }),
        seal(4, 500),
    ]);
    const cache = tracker.makeCache();
    assert.equal(cache.boundary, Number.NEGATIVE_INFINITY); // 连续前缀内无封口
    const token = { identity: "kate", validFrom: 0, validTo: 1000 };
    // 缓存中没有可用时间线（边界为负无穷，无变更 <= 边界）
    assert.equal(checkOffline(cache, token, { start: 300, end: 300 }).decision, "denied");
    const [r] = tracker.reconcile([manualEntry(token, { start: 300, end: 300 })]);
    assert.equal(r.status, "pending");
    // 补齐 seq2 的封口后，边界推进，撤销生效
    tracker.ingestAuthority([seal(2, 150)]);
    assert.equal(tracker.makeCache().boundary, 500);
    const [r2] = tracker.reconcile([manualEntry(token, { start: 300, end: 300 })]);
    assert.equal(r2.conclusion, "denied");
});
test("最终结论之后不可翻转", () => {
    const tracker = createTracker();
    tracker.ingestAuthority([change(1, "leo", 100), seal(2, 200)]);
    const token = { identity: "leo", validFrom: 0, validTo: 1000 };
    const entry = manualEntry(token, { start: 120, end: 130 });
    const [first] = tracker.reconcile([entry]);
    assert.equal(first.conclusion, "allowed");
    // 后续更多同步（含新封口）不改写已定稿结论
    tracker.ingestAuthority([
        change(3, "leo", 300, { status: "suspended" }),
        seal(4, 400),
    ]);
    const [again] = tracker.reconcile([entry]);
    assert.deepEqual(again, first);
});

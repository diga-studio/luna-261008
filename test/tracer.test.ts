import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAccessTracer,
  type AuthorityRecord,
  type ChangeRecord,
  type EntryEvent,
  type Token,
} from "../src/index.js";

function change(
  seq: number,
  identity: string,
  effectiveTime: number,
  status: "active" | "suspended" | "deprovisioned",
  extra: Partial<Pick<ChangeRecord, "allowEntry" | "blacklisted">> = {},
): ChangeRecord {
  return {
    kind: "change",
    seq,
    identity,
    effectiveTime,
    status,
    allowEntry: true,
    blacklisted: false,
    ...extra,
  };
}

function seal(seq: number, time: number): AuthorityRecord {
  return { kind: "seal", seq, time };
}

test("缓存放行后撤销再恢复：缺撤销时 pending，补齐后 denied，重复投递不变", () => {
  const tracer = createAccessTracer();
  const token: Token = { identity: "alice", validFrom: 0, validTo: 1000 };

  // 初始：激活 + 封口，导出缓存并本地放行
  tracer.ingestAuthority([change(1, "alice", 100, "active"), seal(2, 150)]);
  const cache = tracer.makeCache();
  const decision = tracer.checkOffline(cache, token, { start: 210, end: 220 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.event.localAllowed, true);

  // 恢复与封口先到，撤销(seq=3)缺失：缺号后的记录不得提前生效
  tracer.ingestAuthority([change(4, "alice", 300, "active"), seal(5, 400)]);
  let results = tracer.reconcile([decision.event]);
  assert.equal(results[0]!.verdict, "pending");
  assert.equal(results[0]!.anomaly, false);

  // 补齐撤销：窗口完全落在撤销期间 -> denied，且本地曾放行 -> 异常
  tracer.ingestAuthority([change(3, "alice", 200, "suspended")]);
  results = tracer.reconcile([decision.event]);
  assert.equal(results[0]!.verdict, "denied");
  assert.equal(results[0]!.anomaly, true);

  // 重复投递全部记录不改变结果
  tracer.ingestAuthority([
    change(1, "alice", 100, "active"),
    seal(2, 150),
    change(3, "alice", 200, "suspended"),
    change(4, "alice", 300, "active"),
    seal(5, 400),
  ]);
  results = tracer.reconcile([decision.event]);
  assert.equal(results[0]!.verdict, "denied");
  assert.equal(results[0]!.anomaly, true);

  // 旧缓存不被后续同步改写，本地结果不变
  const again = tracer.checkOffline(cache, token, { start: 210, end: 220 });
  assert.equal(again.allowed, true);
});

test("两端允许中间暂停为 uncertain，且不作为确定违规", () => {
  const tracer = createTracerWithPause();
  const token: Token = { identity: "carol", validFrom: 0, validTo: 1000 };
  const event: EntryEvent = {
    id: "e1",
    token,
    window: { start: 150, end: 350 },
    localAllowed: true,
  };
  const [result] = tracer.reconcile([event]);
  assert.equal(result!.verdict, "uncertain");
  assert.equal(result!.anomaly, false);
});

function createTracerWithPause() {
  const tracer = createAccessTracer();
  tracer.ingestAuthority([
    change(1, "carol", 100, "active"),
    change(2, "carol", 200, "suspended"),
    change(3, "carol", 300, "active"),
    seal(4, 400),
  ]);
  return tracer;
}

test("整段允许为 allowed，整段拒绝为 denied", () => {
  const tracer = createTracerWithPause();
  const token: Token = { identity: "carol", validFrom: 0, validTo: 1000 };
  const mk = (id: string, start: number, end: number): EntryEvent => ({
    id,
    token,
    window: { start, end },
    localAllowed: false,
  });
  const results = tracer.reconcile([mk("a", 150, 199), mk("b", 200, 299), mk("c", 300, 350)]);
  assert.deepEqual(
    results.map((r) => r.verdict),
    ["allowed", "denied", "allowed"],
  );
  // localAllowed 为 false 时 denied 不算异常
  assert.equal(results[1]!.anomaly, false);
});

test("同毫秒多次变更取最大 seq", () => {
  const tracer = createAccessTracer();
  tracer.ingestAuthority([
    change(1, "dave", 100, "active"),
    change(2, "dave", 100, "suspended"), // 同毫秒，seq 更大者生效
    change(3, "erin", 100, "suspended"),
    change(4, "erin", 100, "active"), // 同毫秒恢复到 active
    seal(5, 200),
  ]);
  const cache = tracer.makeCache();
  const dave: Token = { identity: "dave", validFrom: 0, validTo: 1000 };
  const erin: Token = { identity: "erin", validFrom: 0, validTo: 1000 };
  // 单点窗口：dave 在 t=100 为 suspended
  assert.equal(tracer.checkOffline(cache, dave, { start: 100, end: 100 }).allowed, false);
  // erin 在 t=100 最终为 active
  assert.equal(tracer.checkOffline(cache, erin, { start: 100, end: 100 }).allowed, true);
  // 首次变更之前视为拒绝
  assert.equal(tracer.checkOffline(cache, erin, { start: 99, end: 99 }).allowed, false);
});

test("令牌有效期左闭右开：到期右端点拒绝", () => {
  const tracer = createTracerWithPause();
  const cache = tracer.makeCache();
  const token: Token = { identity: "carol", validFrom: 300, validTo: 350 };
  // 右端点 350 不在有效期内
  assert.equal(tracer.checkOffline(cache, token, { start: 340, end: 350 }).allowed, false);
  assert.equal(tracer.checkOffline(cache, token, { start: 340, end: 349 }).allowed, true);
  // 左端点 300 在有效期内
  assert.equal(tracer.checkOffline(cache, token, { start: 300, end: 300 }).allowed, true);
  // 单点窗口恰好落在到期时刻 -> denied
  const event: EntryEvent = {
    id: "exp",
    token,
    window: { start: 350, end: 350 },
    localAllowed: false,
  };
  const [result] = tracer.reconcile([event]);
  assert.equal(result!.verdict, "denied");
});

test("乱序与重复导入得到相同缓存；缺号记录不影响缓存", () => {
  const ordered = createAccessTracer();
  ordered.ingestAuthority([
    change(1, "frank", 100, "active"),
    change(2, "frank", 200, "suspended"),
    seal(3, 250),
  ]);
  const shuffled = createAccessTracer();
  shuffled.ingestAuthority([
    seal(3, 250),
    change(2, "frank", 200, "suspended"),
    change(1, "frank", 100, "active"),
    change(2, "frank", 200, "suspended"), // 重复
    seal(3, 250), // 重复
  ]);
  assert.deepEqual(shuffled.makeCache(), ordered.makeCache());

  // 缺 seq=2 时，seq=3 的封口不生效
  const gapped = createAccessTracer();
  gapped.ingestAuthority([change(1, "frank", 100, "active"), seal(3, 250)]);
  assert.equal(gapped.makeCache().boundary, -Infinity);
  const token: Token = { identity: "frank", validFrom: 0, validTo: 1000 };
  const event: EntryEvent = {
    id: "g",
    token,
    window: { start: 120, end: 130 },
    localAllowed: true,
  };
  assert.equal(gapped.reconcile([event])[0]!.verdict, "pending");
});

test("窗口上界超过已知边界为 pending；无权限与黑名单拒绝", () => {
  const tracer = createAccessTracer();
  tracer.ingestAuthority([
    change(1, "gina", 100, "active", { allowEntry: false }),
    change(2, "hank", 100, "active", { blacklisted: true }),
    seal(3, 200),
  ]);
  const cache = tracer.makeCache();
  const gina: Token = { identity: "gina", validFrom: 0, validTo: 1000 };
  const hank: Token = { identity: "hank", validFrom: 0, validTo: 1000 };
  assert.equal(tracer.checkOffline(cache, gina, { start: 150, end: 150 }).allowed, false);
  assert.equal(tracer.checkOffline(cache, hank, { start: 150, end: 150 }).allowed, false);
  // 窗口超出边界 -> pending
  const event: EntryEvent = {
    id: "p",
    token: gina,
    window: { start: 150, end: 300 },
    localAllowed: false,
  };
  assert.equal(tracer.reconcile([event])[0]!.verdict, "pending");
});

test("最终结论不可翻转：更多历史到达后结论保持", () => {
  const tracer = createTracerWithPause();
  const token: Token = { identity: "carol", validFrom: 0, validTo: 1000 };
  const event: EntryEvent = {
    id: "stable",
    token,
    window: { start: 150, end: 199 },
    localAllowed: true,
  };
  assert.equal(tracer.reconcile([event])[0]!.verdict, "allowed");
  // 后续更晚的变更与封口到达，不影响已封口历史
  tracer.ingestAuthority([change(5, "carol", 500, "deprovisioned"), seal(6, 600)]);
  assert.equal(tracer.reconcile([event])[0]!.verdict, "allowed");
});

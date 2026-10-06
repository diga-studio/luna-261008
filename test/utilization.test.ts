import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckinStatus, UtilizationLedger } from "../src/index";
import { CheckinSubmission } from "../src/types";
import { makeRng, randomSubmissions, referenceOccupiedMs } from "./helpers";

const MIN = 60 * 1000;
const SHIFT = 8 * 60 * MIN;

function occupiedOf(results: { zoneId: string; occupiedMs: number }[]): Map<string, number> {
  return new Map(results.map((r) => [r.zoneId, r.occupiedMs]));
}

function assertMatchesReference(
  ledger: UtilizationLedger,
  submissions: CheckinSubmission[],
  startMs: number,
  endMs: number,
  zoneIds: string[],
): void {
  const capacities = new Map(zoneIds.map((z) => [z, 3]));
  const actual = occupiedOf(ledger.queryUtilization(startMs, endMs, capacities));
  const expected = referenceOccupiedMs(submissions, startMs, endMs);
  for (const zoneId of zoneIds) {
    assert.equal(
      actual.get(zoneId) ?? 0,
      expected.get(zoneId) ?? 0,
      `zone ${zoneId} occupiedMs mismatch in [${startMs}, ${endMs})`,
    );
  }
}

test("跨班次查询与10分钟到期边界", () => {
  const ledger = new UtilizationLedger(":memory:");
  const caps = new Map([
    ["A", 1],
    ["B", 2],
  ]);
  const subs: CheckinSubmission[] = [];

  // 班次1开始前 5 分钟的签到，效力延续到班次1开头
  subs.push({ eventId: 1, workerId: 1, occurredAt: -5 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  ledger.submitCheckin(subs[0]);

  // 班次1 [0, 8h)：工人1 从 0 占用到 5*MIN（签到后 10 分钟到期）
  let r = ledger.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 5 * MIN);
  assert.equal(r.find((x) => x.zoneId === "A")!.utilization, (5 * MIN) / SHIFT);
  // 班次2 [8h, 16h)：已到期，无占用
  r = ledger.queryUtilization(SHIFT, 2 * SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 0);

  // 到期边界：查询 [0, 5*MIN) 满额占用；[5*MIN, ...) 不再占用（左闭右开，到期时刻不占用）
  r = ledger.queryUtilization(0, 5 * MIN, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 5 * MIN);
  assert.equal(r.find((x) => x.zoneId === "A")!.utilization, 1);
  r = ledger.queryUtilization(5 * MIN, 10 * MIN, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 0);

  // 休息终止上一条签到；新签到截断前一条
  subs.push({ eventId: 2, workerId: 2, occurredAt: 0, status: CheckinStatus.Working, zoneId: "A", revision: 0 });
  subs.push({ eventId: 3, workerId: 2, occurredAt: 2 * MIN, status: CheckinStatus.Rest, zoneId: "A", revision: 0 });
  subs.push({ eventId: 4, workerId: 2, occurredAt: 4 * MIN, status: CheckinStatus.Available, zoneId: "B", revision: 0 });
  for (const s of subs.slice(1)) ledger.submitCheckin(s);

  r = ledger.queryUtilization(0, SHIFT, caps);
  // 工人2：A 区 [0, 2min) 工作，休息终止；B 区 [4min, 14min) 可用
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 5 * MIN + 2 * MIN);
  assert.equal(r.find((x) => x.zoneId === "B")!.occupiedMs, 10 * MIN);
  // B 区容量 2：利用率 = 10min / (2 * 8h)
  assert.equal(r.find((x) => x.zoneId === "B")!.utilization, (10 * MIN) / (2 * SHIFT));

  // 利用率超过 100% 照实返回：容量 1 的区域内两名工人同时占用
  subs.push({ eventId: 5, workerId: 3, occurredAt: 20 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  subs.push({ eventId: 6, workerId: 4, occurredAt: 20 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  ledger.submitCheckin(subs[4]);
  ledger.submitCheckin(subs[5]);
  r = ledger.queryUtilization(20 * MIN, 30 * MIN, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 2 * 10 * MIN);
  assert.equal(r.find((x) => x.zoneId === "A")!.utilization, 2);

  // 每次提交后都与独立参考实现一致
  assertMatchesReference(ledger, subs, 0, SHIFT, ["A", "B"]);
  assertMatchesReference(ledger, subs, SHIFT, 2 * SHIFT, ["A", "B"]);
  ledger.close();
});

test("乱序补传后更正时间和区域", () => {
  const ledger = new UtilizationLedger(":memory:");
  const caps = new Map([
    ["A", 1],
    ["B", 1],
  ]);
  const subs: CheckinSubmission[] = [];
  const push = (s: CheckinSubmission) => {
    subs.push(s);
    ledger.submitCheckin(s);
  };

  // 初始：工人1 在 10min 于 A 区可用
  push({ eventId: 1, workerId: 1, occurredAt: 10 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  let r = ledger.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 10 * MIN);

  // 修订：把时间改到 30min、区域改到 B —— A 的影响消除，B 生效
  push({ eventId: 1, workerId: 1, occurredAt: 30 * MIN, status: CheckinStatus.Available, zoneId: "B", revision: 1 });
  r = ledger.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 0);
  assert.equal(r.find((x) => x.zoneId === "B")!.occupiedMs, 10 * MIN);

  // 重复提交旧修订（rev0）：不产生影响
  push({ eventId: 1, workerId: 1, occurredAt: 10 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  r = ledger.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 0);
  assert.equal(r.find((x) => x.zoneId === "B")!.occupiedMs, 10 * MIN);

  // 乱序补传：迟到的事件发生在更早时刻，截断工人1在 B 区的占用
  push({ eventId: 2, workerId: 1, occurredAt: 35 * MIN, status: CheckinStatus.OffDuty, zoneId: "B", revision: 0 });
  r = ledger.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "B")!.occupiedMs, 5 * MIN);

  // 同一工人同一时刻多个事件：只采用事件编号最大者
  push({ eventId: 4, workerId: 2, occurredAt: 60 * MIN, status: CheckinStatus.Available, zoneId: "A", revision: 0 });
  push({ eventId: 3, workerId: 2, occurredAt: 60 * MIN, status: CheckinStatus.Working, zoneId: "B", revision: 0 });
  r = ledger.queryUtilization(60 * MIN, 70 * MIN, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 10 * MIN);
  assert.equal(r.find((x) => x.zoneId === "B")!.occupiedMs, 0); // 工人2 的 B 区事件被同刻更大编号事件覆盖

  // 每次提交后都与独立参考实现一致
  assertMatchesReference(ledger, subs, 0, SHIFT, ["A", "B"]);
  assertMatchesReference(ledger, subs, 0, 2 * SHIFT, ["A", "B"]);
  ledger.close();
});

test("随机提交（含修订/乱序/重复）每次提交后与独立计算一致", () => {
  const rng = makeRng(20261008);
  const zones = ["A", "B", "C"];
  const caps = new Map(zones.map((z) => [z, 2]));
  const ledger = new UtilizationLedger(":memory:");
  const submissions = randomSubmissions(rng, 120, 5, zones, -SHIFT, 3 * SHIFT);
  const accepted: CheckinSubmission[] = [];
  const seen = new Set<string>();
  const queries: [number, number][] = [
    [0, SHIFT],
    [SHIFT, 2 * SHIFT],
    [-SHIFT, 3 * SHIFT],
    [Math.floor(SHIFT / 2), SHIFT + Math.floor(SHIFT / 3)],
  ];
  for (const s of submissions) {
    ledger.submitCheckin(s);
    const key = `${s.eventId}:${s.revision}`;
    if (!seen.has(key)) {
      seen.add(key);
      accepted.push(s);
    }
    for (const [qs, qe] of queries) {
      const actual = occupiedOf(ledger.queryUtilization(qs, qe, caps));
      const expected = referenceOccupiedMs(accepted, qs, qe);
      for (const z of zones) {
        assert.equal(
          actual.get(z) ?? 0,
          expected.get(z) ?? 0,
          `zone ${z} mismatch after event ${s.eventId} rev ${s.revision} in [${qs}, ${qe})`,
        );
      }
    }
  }
  ledger.close();
});

test("SQLite 持久化：关闭重开后查询结果不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "util-ledger-"));
  const dbPath = join(dir, "data.sqlite");
  const caps = new Map([["A", 1]]);

  const ledger = new UtilizationLedger(dbPath);
  ledger.submitCheckin({ eventId: 1, workerId: 1, occurredAt: 0, status: CheckinStatus.Working, zoneId: "A", revision: 0 });
  ledger.submitCheckin({ eventId: 1, workerId: 1, occurredAt: MIN, status: CheckinStatus.Working, zoneId: "A", revision: 1 });
  ledger.close();

  const reopened = new UtilizationLedger(dbPath);
  const r = reopened.queryUtilization(0, SHIFT, caps);
  assert.equal(r.find((x) => x.zoneId === "A")!.occupiedMs, 10 * MIN);
  reopened.close();
});

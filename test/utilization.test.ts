import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CHECKIN_TTL_MS,
  CheckinStatus,
  UtilizationService,
  type CheckinEvent,
} from "../src/index.js";
import { bruteForceOccupiedMs, makeEvent, resetEventIds } from "./helpers.js";

const MIN = 60_000;

function occupiedOf(
  service: UtilizationService,
  startMs: number,
  endMs: number,
  zone: string,
): number {
  const rows = service.getUtilization(startMs, endMs, { [zone]: 1 });
  return rows.find((r) => r.zone === zone)?.occupiedMs ?? 0;
}

test("跨班次查询：签到 10 分钟到期后不再占用，也不恢复", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  // 工人在 0 时刻签到可用，之后再无签到。
  service.submitCheckin(
    makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Available, zone: "A", revision: 1 }),
  );
  // 班次一 [0, 8h)：只占用前 10 分钟。
  assert.equal(occupiedOf(service, 0, 8 * 60 * MIN, "A"), CHECKIN_TTL_MS);
  // 班次二 [8h, 16h)：签到早已到期，占用为 0。
  assert.equal(occupiedOf(service, 8 * 60 * MIN, 16 * 60 * MIN, "A"), 0);
  // 到期边界：左闭右开，[10min, 20min) 内占用为 0。
  assert.equal(occupiedOf(service, CHECKIN_TTL_MS, 2 * CHECKIN_TTL_MS, "A"), 0);
  // [0, 10min) 恰好占满。
  assert.equal(occupiedOf(service, 0, CHECKIN_TTL_MS, "A"), CHECKIN_TTL_MS);
  service.close();
});

test("10 分钟到期边界：下一条签到与到期取较早者；休息终止上一条", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  // 工人 1：0 时刻工作，恰好在 10 分钟时刻再次签到（休息）。
  service.submitCheckin(
    makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Working, zone: "A", revision: 1 }),
  );
  service.submitCheckin(
    makeEvent({ workerId: 1, occurredAtMs: CHECKIN_TTL_MS, status: CheckinStatus.Break, zone: "A", revision: 1 }),
  );
  // 第一条生效 [0, 10min)，到期时刻不再占用。
  assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), CHECKIN_TTL_MS);

  // 工人 2：0 时刻可用，3 分钟后休息 → 只占用 3 分钟。
  service.submitCheckin(
    makeEvent({ workerId: 2, occurredAtMs: 0, status: CheckinStatus.Available, zone: "B", revision: 1 }),
  );
  service.submitCheckin(
    makeEvent({ workerId: 2, occurredAtMs: 3 * MIN, status: CheckinStatus.Break, zone: "B", revision: 1 }),
  );
  assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), 3 * MIN);
  service.close();
});

test("查询开始前的签到影响区间开头（跨班次带入）", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  // 签到发生在查询区间开始之前 5 分钟。
  service.submitCheckin(
    makeEvent({ workerId: 1, occurredAtMs: -5 * MIN, status: CheckinStatus.Working, zone: "A", revision: 1 }),
  );
  // 区间 [0, 4min)：签到效力持续到 5min，覆盖整个区间。
  assert.equal(occupiedOf(service, 0, 4 * MIN, "A"), 4 * MIN);
  // 区间 [4min, 6min)：只覆盖 [4min, 5min)。
  assert.equal(occupiedOf(service, 4 * MIN, 6 * MIN, "A"), 1 * MIN);
  service.close();
});

test("乱序补传后更正时间和区域：旧位置影响消除，新位置立即生效", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  const capacities = { A: 1, B: 1 };

  // 先到一条较新的签到（事件发生更晚）。
  const later = makeEvent({ workerId: 1, occurredAtMs: 20 * MIN, status: CheckinStatus.Working, zone: "A", revision: 1 });
  service.submitCheckin(later);
  // 乱序补传一条更早的签到。
  const earlier = makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Available, zone: "A", revision: 1 });
  service.submitCheckin(earlier);
  // 补传后：早签到 [0,10min) 有效，晚签到 [20min,30min) 有效。
  assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), 2 * CHECKIN_TTL_MS);

  // 事后更正：早签到改到 5min、区域 B（修订号 +1）。
  const corrected = { ...earlier, occurredAtMs: 5 * MIN, zone: "B", revision: 2 };
  service.submitCheckin(corrected);
  // 区域 A 只剩 [20min,30min)；区域 B 出现 [5min,15min)。
  assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), CHECKIN_TTL_MS);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), CHECKIN_TTL_MS);

  // 重复提交较旧修订（rev 1）不产生任何影响。
  service.submitCheckin(earlier);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), CHECKIN_TTL_MS);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), CHECKIN_TTL_MS);
  // 重复提交同一修订（内容一致）也不产生影响。
  service.submitCheckin(corrected);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), CHECKIN_TTL_MS);

  // 与独立校验器一致。
  const all: CheckinEvent[] = [later, earlier, corrected];
  const expected = bruteForceOccupiedMs(all, 0, 60 * MIN);
  for (const row of service.getUtilization(0, 60 * MIN, capacities)) {
    assert.equal(row.occupiedMs, expected.get(row.zone) ?? 0, `zone ${row.zone}`);
  }
  service.close();
});

test("同一工人同一时刻只取事件编号最大者", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  const small = makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Available, zone: "A", revision: 1 });
  const large = makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Working, zone: "B", revision: 1 });
  assert.ok(large.eventId > small.eventId);
  // 乱序提交：先大后小。
  service.submitCheckin(large);
  service.submitCheckin(small);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), 0);
  assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), CHECKIN_TTL_MS);
  service.close();
});

test("利用率 = 累计占用 / (容量 × 区间长度)，超过 100% 照实返回", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  // 两名工人同时在区域 A，容量只有 1。
  for (const workerId of [1, 2]) {
    service.submitCheckin(
      makeEvent({ workerId, occurredAtMs: 0, status: CheckinStatus.Working, zone: "A", revision: 1 }),
    );
  }
  const [row] = service.getUtilization(0, CHECKIN_TTL_MS, { A: 1 });
  assert.equal(row.occupiedMs, 2 * CHECKIN_TTL_MS);
  assert.equal(row.utilization, 2);
  // 容量为 2 时利用率为 1。
  const [row2] = service.getUtilization(0, CHECKIN_TTL_MS, { A: 2 });
  assert.equal(row2.utilization, 1);
  service.close();
});

test("SQLite 持久化：关闭重开后历史与修订仍在", () => {
  resetEventIds();
  const dir = mkdtempSync(path.join(tmpdir(), "zone-util-"));
  const dbPath = path.join(dir, "checkins.db");
  try {
    const event = makeEvent({ workerId: 1, occurredAtMs: 0, status: CheckinStatus.Working, zone: "A", revision: 1 });
    let service = new UtilizationService(dbPath);
    service.submitCheckin(event);
    service.submitCheckin({ ...event, zone: "B", revision: 2 });
    service.close();

    service = new UtilizationService(dbPath);
    assert.equal(occupiedOf(service, 0, 60 * MIN, "A"), 0);
    assert.equal(occupiedOf(service, 0, 60 * MIN, "B"), CHECKIN_TTL_MS);
    service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("随机乱序提交与修订：每次提交后都与独立直接计算完全一致", () => {
  resetEventIds();
  const service = new UtilizationService(":memory:");
  const submitted: CheckinEvent[] = [];
  // 确定性伪随机序列。
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const statuses = [CheckinStatus.Available, CheckinStatus.Working, CheckinStatus.Break, CheckinStatus.OffDuty];
  const zones = ["A", "B", "C"];
  const window = { start: -30 * MIN, end: 6 * 60 * MIN };

  // 预生成 60 个事件，随机时刻；之后随机修订其中一部分。
  const baseEvents: CheckinEvent[] = [];
  for (let i = 0; i < 60; i++) {
    baseEvents.push(
      makeEvent({
        workerId: 1 + Math.floor(rand() * 5),
        occurredAtMs: Math.floor(rand() * 6 * 60 * MIN) - 20 * MIN,
        status: statuses[Math.floor(rand() * statuses.length)],
        zone: zones[Math.floor(rand() * zones.length)],
        revision: 1,
      }),
    );
  }
  const submissions: CheckinEvent[] = [...baseEvents];
  for (let i = 0; i < 40; i++) {
    const base = baseEvents[Math.floor(rand() * baseEvents.length)];
    submissions.push({
      ...base,
      occurredAtMs: Math.floor(rand() * 6 * 60 * MIN) - 20 * MIN,
      status: statuses[Math.floor(rand() * statuses.length)],
      zone: zones[Math.floor(rand() * zones.length)],
      revision: base.revision + 1 + i, // 保证递增
    });
  }
  // 打乱提交顺序（模拟乱序补传）。
  for (let i = submissions.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [submissions[i], submissions[j]] = [submissions[j], submissions[i]];
  }

  const capacities = { A: 2, B: 3, C: 1 };
  for (const event of submissions) {
    service.submitCheckin(event);
    submitted.push(event);
    // 每次提交后立即核对：服务结果 == 依据全部有效签到直接计算。
    const expected = bruteForceOccupiedMs(submitted, window.start, window.end);
    for (const row of service.getUtilization(window.start, window.end, capacities)) {
      assert.equal(
        row.occupiedMs,
        expected.get(row.zone) ?? 0,
        `zone ${row.zone} after event ${event.eventId} rev ${event.revision}`,
      );
      assert.equal(
        row.utilization,
        row.occupiedMs / (row.capacity * (window.end - window.start)),
      );
    }
    // 再核对一个随机子区间。
    const subStart = window.start + Math.floor(rand() * 4 * 60 * MIN);
    const subEnd = subStart + Math.floor(rand() * 2 * 60 * MIN) + 1;
    const subExpected = bruteForceOccupiedMs(submitted, subStart, subEnd);
    for (const row of service.getUtilization(subStart, subEnd, capacities)) {
      assert.equal(row.occupiedMs, subExpected.get(row.zone) ?? 0);
    }
  }
  service.close();
});

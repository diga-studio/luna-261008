import test from "node:test";
import assert from "node:assert/strict";
import {
  AlertChange,
  AlertTracker,
  DownloadEvent,
  Interval,
} from "../src/index";

function ev(
  eventId: string,
  employeeId: string,
  fileId: string,
  timestamp: number,
): DownloadEvent {
  return { eventId, employeeId, fileId, timestamp };
}

/** 生成 files[i] 在时刻 t 被 employee 下载的事件。 */
function batch(
  employeeId: string,
  files: string[],
  timestamp: number,
  idPrefix: string,
): DownloadEvent[] {
  return files.map((fileId, i) =>
    ev(`${idPrefix}-${i}`, employeeId, fileId, timestamp),
  );
}

function fileIds(prefix: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
}

function assertChanges(
  actual: AlertChange[],
  expected: AlertChange[],
): void {
  const norm = (cs: AlertChange[]) =>
    cs
      .map((c) => ({
        employeeId: c.employeeId,
        added: [...c.added].sort((a, b) => a.start - b.start),
        removed: [...c.removed].sort((a, b) => a.start - b.start),
      }))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  assert.deepEqual(norm(actual), norm(expected));
}

test("50 个文件反复下载不产生告警", () => {
  const tracker = new AlertTracker();
  const files = fileIds("f", 50);
  // 同一批文件在窗口内被反复下载（不同 eventId），文件数仍是 50。
  const c1 = tracker.ingest(batch("emp", files, 1000, "a"));
  const c2 = tracker.ingest(batch("emp", files, 1100, "b"));
  const c3 = tracker.ingest(batch("emp", files, 1599, "c"));
  assertChanges(c1, []);
  assertChanges(c2, []);
  assertChanges(c3, []);
  assert.deepEqual(tracker.getAlerts("emp"), []);
});

test("第 51 个文件加入后产生准确区间，终点由失效时刻决定", () => {
  const tracker = new AlertTracker();
  const files50 = fileIds("f", 50);
  // 50 个文件在 t=1000 下载，并在 1200 重复下载延长到 1800。
  tracker.ingest(batch("emp", files50, 1000, "a"));
  tracker.ingest(batch("emp", files50, 1200, "b"));
  // 第 51 个文件在 t=1000 加入，活跃 [1000,1600)。
  const changes = tracker.ingest([ev("x", "emp", "f50", 1000)]);
  // 告警区间 = 51 个文件同时活跃的 [1000,1600)，终点 1600 不出现在任何下载时刻。
  assertChanges(changes, [
    { employeeId: "emp", added: [{ start: 1000, end: 1600 }], removed: [] },
  ]);
  assert.deepEqual(tracker.getAlerts("emp"), [{ start: 1000, end: 1600 }]);
});

test("同一秒多个文件同时开始与失效", () => {
  const tracker = new AlertTracker();
  // 51 个文件同一秒开始。
  const changes = tracker.ingest(batch("emp", fileIds("f", 51), 500, "a"));
  assertChanges(changes, [
    { employeeId: "emp", added: [{ start: 500, end: 1100 }], removed: [] },
  ]);
  // 同一秒 51 个文件同时失效、1 个新文件开始：告警在 1100 准时结束。
  const c2 = tracker.ingest([ev("late", "emp", "g0", 1100)]);
  assertChanges(c2, []);
  assert.deepEqual(tracker.getAlerts("emp"), [{ start: 500, end: 1100 }]);
});

test("恰好相隔 600 秒：起点包含、终点不包含", () => {
  const tracker = new AlertTracker();
  // 50 个文件在 t=0，第 51 个恰好在前 50 个失效的同一秒 t=600 下载。
  tracker.ingest(batch("emp", fileIds("f", 50), 0, "a"));
  const changes = tracker.ingest([ev("x", "emp", "f50", 600)]);
  // t=600 时前 50 个已失效（终点不包含），任何时刻都不到 51 个。
  assertChanges(changes, []);
  assert.deepEqual(tracker.getAlerts("emp"), []);

  // 第 51 个文件在 t=599 下载：只有 [599,600) 这一秒达到 51 个。
  const tracker2 = new AlertTracker();
  tracker2.ingest(batch("emp", fileIds("f", 50), 0, "a"));
  const c2 = tracker2.ingest([ev("x", "emp", "f50", 599)]);
  assertChanges(c2, [
    { employeeId: "emp", added: [{ start: 599, end: 600 }], removed: [] },
  ]);
});

test("延长活跃时间合并相接区间，不产生零长度区间", () => {
  const tracker = new AlertTracker();
  const files = fileIds("f", 51);
  tracker.ingest(batch("emp", files, 0, "a"));
  // 恰好在上批失效的同一秒 t=600 全部重新下载：活跃区间相接，合并为 [0,1200)。
  const changes = tracker.ingest(batch("emp", files, 600, "b"));
  assertChanges(changes, [
    {
      employeeId: "emp",
      added: [{ start: 0, end: 1200 }],
      removed: [{ start: 0, end: 600 }],
    },
  ]);
  const alerts = tracker.getAlerts("emp");
  assert.deepEqual(alerts, [{ start: 0, end: 1200 }]);
  for (const iv of alerts) {
    assert.ok(iv.end > iv.start, "不允许零长度区间");
  }
});

test("迟到下载连接两个分离告警，净变化为删二增一", () => {
  const tracker = new AlertTracker();
  const groupA = fileIds("a", 51); // t=0   -> 告警 [0,600)
  const groupB = fileIds("b", 51); // t=650 -> 告警 [650,1250)
  tracker.ingest(batch("emp", groupA, 0, "a"));
  const setup = tracker.ingest(batch("emp", groupB, 650, "b"));
  assertChanges(setup, [
    { employeeId: "emp", added: [{ start: 650, end: 1250 }], removed: [] },
  ]);
  assert.deepEqual(tracker.getAlerts("emp"), [
    { start: 0, end: 600 },
    { start: 650, end: 1250 },
  ]);

  // 迟到事件：groupA 在 t=100 的重复下载把活跃延长到 700，桥接 [600,650)。
  const late = batch("emp", groupA, 100, "late");
  const changes = tracker.ingest(late);
  assertChanges(changes, [
    {
      employeeId: "emp",
      added: [{ start: 0, end: 1250 }],
      removed: [
        { start: 0, end: 600 },
        { start: 650, end: 1250 },
      ],
    },
  ]);
  assert.deepEqual(tracker.getAlerts("emp"), [{ start: 0, end: 1250 }]);

  // 重放同一批次（相同 eventId）：状态不变，净变化为空。
  const replay = tracker.ingest(late);
  assertChanges(replay, []);
  assert.deepEqual(tracker.getAlerts("emp"), [{ start: 0, end: 1250 }]);
});

test("重复 eventId 与同文件不同 eventId 都不重复贡献", () => {
  const tracker = new AlertTracker();
  const events = batch("emp", fileIds("f", 51), 100, "a");
  tracker.ingest(events);
  // 整批重放。
  assertChanges(tracker.ingest(events), []);
  // 逐条重放。
  for (const e of events) {
    assertChanges(tracker.ingest([e]), []);
  }
  assert.deepEqual(tracker.getAlerts("emp"), [{ start: 100, end: 700 }]);

  // 50 个不同文件 + 同一文件的多次下载（不同 eventId）：仍只有 50 个文件。
  const tracker2 = new AlertTracker();
  tracker2.ingest(batch("emp", fileIds("f", 50), 0, "a"));
  const dup = tracker2.ingest([
    ev("d1", "emp", "f0", 10),
    ev("d2", "emp", "f0", 20),
    ev("d3", "emp", "f0", 30),
  ]);
  assertChanges(dup, []);
  assert.deepEqual(tracker2.getAlerts("emp"), []);
});

test("结果只取决于事件集合，与批次划分和到达顺序无关", () => {
  // 构造一组乱序后仍应有确定结果的事件。
  const events: DownloadEvent[] = [
    ...batch("emp", fileIds("a", 51), 0, "a"),
    ...batch("emp", fileIds("b", 51), 650, "b"),
    ...batch("emp", fileIds("a", 51), 100, "late"),
    ...batch("emp", fileIds("c", 30), 5000, "c"),
    ...batch("emp", fileIds("c", 21, 30), 5050, "c2"),
    ...batch("emp", fileIds("c", 30), 5600, "c3"),
  ];
  const expected: Interval[] = [
    { start: 0, end: 1250 },
    // c 组：t=5000 只有 30 个，t=5050 达到 51 个，t=5600 的重复下载
    // 把前 30 个延长到 6200，但 t=5650 起后 21 个失效，只剩 30 个。
    { start: 5050, end: 5650 },
  ];

  // 基准：单批。
  const reference = new AlertTracker();
  reference.ingest(events);
  assert.deepEqual(reference.getAlerts("emp"), expected);

  // 逐条、正序。
  const oneByOne = new AlertTracker();
  for (const e of events) {
    oneByOne.ingest([e]);
  }
  assert.deepEqual(oneByOne.getAlerts("emp"), expected);

  // 确定性乱序 + 随机批次划分。
  const shuffled = [...events];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const randomBatches = new AlertTracker();
  let cursor = 0;
  while (cursor < shuffled.length) {
    const size = 1 + Math.floor(rand() * 17);
    randomBatches.ingest(shuffled.slice(cursor, cursor + size));
    cursor += size;
  }
  assert.deepEqual(randomBatches.getAlerts("emp"), expected);

  // 逆序、按员工无关维度切批。
  const reversed = new AlertTracker();
  const rev = [...events].reverse();
  for (let i = 0; i < rev.length; i += 33) {
    reversed.ingest(rev.slice(i, i + 33));
  }
  assert.deepEqual(reversed.getAlerts("emp"), expected);
});

test("多员工互不干扰，净变化按员工分组", () => {
  const tracker = new AlertTracker();
  const changes = tracker.ingest([
    ...batch("e1", fileIds("f", 51), 0, "a"),
    ...batch("e2", fileIds("f", 50), 0, "b"),
  ]);
  assertChanges(changes, [
    { employeeId: "e1", added: [{ start: 0, end: 600 }], removed: [] },
  ]);
  assert.deepEqual(tracker.getAlerts("e1"), [{ start: 0, end: 600 }]);
  assert.deepEqual(tracker.getAlerts("e2"), []);
  assert.deepEqual(tracker.getAlerts("nobody"), []);
});

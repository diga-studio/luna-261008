import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats, type ActivityEvent, type EngagementStats } from '../src/index.js';

const MIN = 60_000;
const DAY1 = '2024-03-01';
const DAY2 = '2024-03-02';
const T = (iso: string): number => Date.parse(iso + 'Z');

let seq = 0;
function ev(partial: Omit<ActivityEvent, 'eventId'> & { eventId?: string }): ActivityEvent {
  seq += 1;
  const { eventId, ...rest } = partial;
  return { eventId: eventId ?? `evt-${String(seq).padStart(6, '0')}`, ...rest };
}

function withStats(fn: (stats: EngagementStats) => void): void {
  const stats = createStats(':memory:');
  try {
    fn(stats);
  } finally {
    stats.close();
  }
}

test('跨午夜打开被迟到动作缩短，停留归打开日期，重投不重复计数', () => {
  withStats((stats) => {
    const openTs = T('2024-03-01T23:50:00.000');
    const open = ev({
      eventId: 'open-1',
      roomId: 'r1',
      sessionId: 's1',
      userId: 'u1',
      timestamp: openTs,
      action: 'open',
      docId: 'docA',
    });

    // 第一批：只有打开，没有后继动作 → 无有效停留
    assert.deepEqual(stats.importEvents([open]), { received: 1, inserted: 1 });
    assert.deepEqual(stats.getDailyReport('r1', 'docA', DAY1), {
      roomId: 'r1',
      docId: 'docA',
      date: DAY1,
      opens: 1,
      uniqueReaders: 1,
      downloads: 0,
      avgDwellMs: null,
    });

    // 第二批：乱序汇入一个 00:30 的后继（间隔 40 分钟 > 20 分钟，仍无效）
    const lateFar = ev({
      eventId: 'other-far',
      roomId: 'r1',
      sessionId: 's1',
      userId: 'u1',
      timestamp: openTs + 40 * MIN,
      action: 'other',
    });
    stats.importEvents([lateFar]);
    assert.equal(stats.getDailyReport('r1', 'docA', DAY1)!.avgDwellMs, null);

    // 第三批：迟到事件落在打开后 5 分钟，把停留缩短为 5 分钟（有效）
    const lateNear = ev({
      eventId: 'other-near',
      roomId: 'r1',
      sessionId: 's1',
      userId: 'u1',
      timestamp: openTs + 5 * MIN,
      action: 'other',
    });
    stats.importEvents([lateNear]);
    const day1 = stats.getDailyReport('r1', 'docA', DAY1)!;
    assert.equal(day1.avgDwellMs, 5 * MIN);
    assert.equal(day1.opens, 1);

    // 跨午夜的停留全部归打开发生的日期，次日没有打开
    assert.equal(stats.getDailyReport('r1', 'docA', DAY2), null);

    // 整批重投：全部去重，指标不变
    assert.deepEqual(stats.importEvents([lateNear, open, lateFar]), { received: 3, inserted: 0 });
    assert.deepEqual(stats.getDailyReport('r1', 'docA', DAY1), day1);
  });
});

test('同一用户多会话同毫秒动作，会话互不结束停留，独立用户只算一个', () => {
  withStats((stats) => {
    const t0 = T('2024-03-01T10:00:00.000');
    // 同一毫秒：会话 s1 打开、会话 s2 打开（事件 ID 字典序决定同毫秒顺序）
    const open1 = ev({ eventId: 'a-open', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0, action: 'open', docId: 'docA' });
    const open2 = ev({ eventId: 'b-open', roomId: 'r1', sessionId: 's2', userId: 'u1', timestamp: t0, action: 'open', docId: 'docA' });
    // s1 的后继：60 秒后的其他动作；s2 的后继：120 秒后下载另一文档
    const end1 = ev({ eventId: 'c-end', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0 + 60_000, action: 'other' });
    const end2 = ev({ eventId: 'd-end', roomId: 'r1', sessionId: 's2', userId: 'u1', timestamp: t0 + 120_000, action: 'download', docId: 'docB' });

    // 乱序、分批导入
    stats.importEvents([end2, open2]);
    stats.importEvents([end1]);
    stats.importEvents([open1]);

    const report = stats.getDailyReport('r1', 'docA', DAY1)!;
    assert.equal(report.opens, 2);
    assert.equal(report.uniqueReaders, 1);
    assert.equal(report.downloads, 0);
    // 会话互不结束停留：停留分别为 60s 和 120s，而不是被同毫秒的对方截成 0
    assert.equal(report.avgDwellMs, 90_000);

    // docB 当天有一次下载、没有打开
    const reportB = stats.getDailyReport('r1', 'docB', DAY1)!;
    assert.equal(reportB.opens, 0);
    assert.equal(reportB.downloads, 1);
    assert.equal(reportB.avgDwellMs, null);
  });
});

test('停留边界：恰好 20 分钟与间隔 0 有效，超过 20 分钟无效', () => {
  withStats((stats) => {
    const t0 = T('2024-03-01T08:00:00.000');
    const events = [
      // 间隔恰好 20 分钟 → 有效
      ev({ eventId: 'e1', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0, action: 'open', docId: 'docA' }),
      ev({ eventId: 'e2', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0 + 20 * MIN, action: 'other' }),
      // 同毫秒下一条（间隔 0）→ 有效，停留 0
      ev({ eventId: 'e3', roomId: 'r1', sessionId: 's2', userId: 'u2', timestamp: t0, action: 'open', docId: 'docA' }),
      ev({ eventId: 'e4', roomId: 'r1', sessionId: 's2', userId: 'u2', timestamp: t0, action: 'download', docId: 'docA' }),
      // 间隔 20 分钟 + 1 毫秒 → 无效
      ev({ eventId: 'e5', roomId: 'r1', sessionId: 's3', userId: 'u3', timestamp: t0, action: 'open', docId: 'docA' }),
      ev({ eventId: 'e6', roomId: 'r1', sessionId: 's3', userId: 'u3', timestamp: t0 + 20 * MIN + 1, action: 'other' }),
    ];
    stats.importEvents(events);

    const report = stats.getDailyReport('r1', 'docA', DAY1)!;
    assert.equal(report.opens, 3);
    assert.equal(report.uniqueReaders, 3);
    assert.equal(report.downloads, 1);
    // 有效停留：20 分钟和 0，平均 10 分钟
    assert.equal(report.avgDwellMs, 10 * MIN);
  });
});

test('打开另一份文档会结束前一次打开的停留', () => {
  withStats((stats) => {
    const t0 = T('2024-03-01T12:00:00.000');
    stats.importEvents([
      ev({ eventId: 'f1', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0, action: 'open', docId: 'docA' }),
      ev({ eventId: 'f2', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0 + 3 * MIN, action: 'open', docId: 'docB' }),
      ev({ eventId: 'f3', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0 + 9 * MIN, action: 'other' }),
    ]);

    assert.equal(stats.getDailyReport('r1', 'docA', DAY1)!.avgDwellMs, 3 * MIN);
    assert.equal(stats.getDailyReport('r1', 'docB', DAY1)!.avgDwellMs, 6 * MIN);
  });
});

test('文件库重开后数据仍在，历史日期日报随迟到事件更新', () => {
  const path = `/tmp/dd-stats-test-${process.pid}.sqlite`;
  const t0 = T('2024-03-01T15:00:00.000');
  const open = ev({ eventId: 'g1', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0, action: 'open', docId: 'docA' });

  const first = createStats(path);
  first.importEvents([open]);
  assert.equal(first.getDailyReport('r1', 'docA', DAY1)!.avgDwellMs, null);
  first.close();

  // 重新打开同一个库，补入迟到的后继动作
  const second = createStats(path);
  try {
    second.importEvents([
      ev({ eventId: 'g2', roomId: 'r1', sessionId: 's1', userId: 'u1', timestamp: t0 + 2 * MIN, action: 'other' }),
    ]);
    const report = second.getDailyReport('r1', 'docA', DAY1)!;
    assert.equal(report.opens, 1);
    assert.equal(report.avgDwellMs, 2 * MIN);
  } finally {
    second.close();
  }
});

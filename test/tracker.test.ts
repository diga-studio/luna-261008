import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngagementTracker } from "../src/index.js";
import type { ActivityEvent } from "../src/index.js";

const MIN = 60_000;
const DAY1 = "2024-01-01";
const DAY2 = "2024-01-02";
const T1 = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z

function ev(partial: Partial<ActivityEvent> & Pick<ActivityEvent, "eventId">): ActivityEvent {
  return {
    roomId: "R1",
    sessionId: "S1",
    userId: "U1",
    timestamp: T1,
    action: "other",
    ...partial,
  };
}

function withTracker(fn: (t: EngagementTracker) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "engagement-"));
  const tracker = new EngagementTracker(join(dir, "test.db"));
  try {
    fn(tracker);
  } finally {
    tracker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cross-midnight open shortened by late event; dwell stays on open's day; re-import idempotent", () => {
  withTracker((t) => {
    const openAt = T1 + 23 * 60 * MIN + 50 * MIN; // 2024-01-01 23:50
    const open = ev({ eventId: "e-open", action: "open", documentId: "D1", timestamp: openAt });
    const lateOther = ev({ eventId: "e-far", timestamp: openAt + 40 * MIN }); // 00:30 next day, >20min away

    // First batch: open + a far-away successor -> dwell invalid.
    t.importEvents([lateOther, open]); // arbitrary order
    let r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 1);
    assert.equal(r.avgDwellMs, null);
    assert.equal(t.getDailyReport("R1", "D1", DAY2).openCount, 0);

    // Late-arriving event at 23:55 shortens the dwell to a valid 5 minutes.
    t.importEvents([ev({ eventId: "e-near", timestamp: openAt + 5 * MIN })]);
    r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.avgDwellMs, 5 * MIN); // fully attributed to open's day
    // Day 2 has no opens/downloads of its own.
    const r2 = t.getDailyReport("R1", "D1", DAY2);
    assert.equal(r2.openCount, 0);
    assert.equal(r2.avgDwellMs, null);

    // Re-importing the whole history must not double count.
    t.importEvents([open, lateOther, ev({ eventId: "e-near", timestamp: openAt + 5 * MIN })]);
    t.importEvents([open]);
    r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 1);
    assert.equal(r.uniqueReaders, 1);
    assert.equal(r.avgDwellMs, 5 * MIN);
  });
});

test("same user, multiple sessions, same-millisecond actions; sessions don't end each other; one unique reader", () => {
  withTracker((t) => {
    const t0 = T1 + 10 * 60 * MIN;
    // Session A: open at t0, own successor at t0+1min.
    // Session B: open at t0 (same ms), own successor at t0+2min.
    t.importEvents([
      ev({ eventId: "b-open", sessionId: "SB", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "a-open", sessionId: "SA", action: "open", documentId: "D1", timestamp: t0 }),
    ]);
    // Before successors arrive, no valid dwell.
    assert.equal(t.getDailyReport("R1", "D1", DAY1).avgDwellMs, null);

    t.importEvents([
      ev({ eventId: "b-next", sessionId: "SB", timestamp: t0 + 2 * MIN }),
      ev({ eventId: "a-next", sessionId: "SA", timestamp: t0 + 1 * MIN }),
    ]);
    const r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 2);
    assert.equal(r.uniqueReaders, 1); // same user across sessions
    // Each session's dwell ended only by its own successor: (1min + 2min) / 2.
    assert.equal(r.avgDwellMs, 1.5 * MIN);
  });
});

test("same-millisecond ordering within a session uses event id ascending; zero gap is valid", () => {
  withTracker((t) => {
    const t0 = T1 + 12 * 60 * MIN;
    t.importEvents([
      ev({ eventId: "e200", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "e100", action: "open", documentId: "D1", timestamp: t0 }),
    ]);
    // e100's successor is e200 (same ms, higher id) -> dwell 0, valid.
    // e200 has no successor -> not counted.
    const r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 2);
    assert.equal(r.avgDwellMs, 0);
  });
});

test("20-minute boundary: exactly 20min valid, just over invalid", () => {
  withTracker((t) => {
    const t0 = T1 + 8 * 60 * MIN;
    t.importEvents([
      ev({ eventId: "ok-open", sessionId: "SA", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "ok-next", sessionId: "SA", timestamp: t0 + 20 * MIN }),
      ev({ eventId: "no-open", sessionId: "SB", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "no-next", sessionId: "SB", timestamp: t0 + 20 * MIN + 1 }),
    ]);
    const r = t.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 2);
    assert.equal(r.avgDwellMs, 20 * MIN); // only the exactly-20min dwell counts
  });
});

test("downloads counted on their own date; other actions don't affect counts", () => {
  withTracker((t) => {
    const t0 = T1 + 23 * 60 * MIN + 59 * MIN; // 23:59 day 1
    t.importEvents([
      ev({ eventId: "dl1", action: "download", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "dl2", action: "download", documentId: "D1", timestamp: t0 + 2 * MIN }), // day 2
      ev({ eventId: "dl3", action: "download", documentId: "D1", timestamp: t0 }), // same ms, day 1
      ev({ eventId: "oth", timestamp: t0 }),
      ev({ eventId: "dl-other-doc", action: "download", documentId: "D2", timestamp: t0 }),
      ev({ eventId: "dl-other-room", roomId: "R2", action: "download", documentId: "D1", timestamp: t0 }),
    ]);
    assert.equal(t.getDailyReport("R1", "D1", DAY1).downloadCount, 2);
    assert.equal(t.getDailyReport("R1", "D1", DAY2).downloadCount, 1);
    assert.equal(t.getDailyReport("R1", "D2", DAY1).downloadCount, 1);
  });
});

test("late event can invalidate nothing but shorten an already counted dwell", () => {
  withTracker((t) => {
    const t0 = T1 + 6 * 60 * MIN;
    t.importEvents([
      ev({ eventId: "o1", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "o2", timestamp: t0 + 10 * MIN }),
    ]);
    assert.equal(t.getDailyReport("R1", "D1", DAY1).avgDwellMs, 10 * MIN);
    // Late event between them shortens the dwell.
    t.importEvents([ev({ eventId: "o1b", timestamp: t0 + 3 * MIN })]);
    assert.equal(t.getDailyReport("R1", "D1", DAY1).avgDwellMs, 3 * MIN);
  });
});

test("persistence: reports survive reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "engagement-"));
  const dbPath = join(dir, "test.db");
  try {
    const t0 = T1 + 5 * 60 * MIN;
    const t1 = new EngagementTracker(dbPath);
    t1.importEvents([
      ev({ eventId: "p1", action: "open", documentId: "D1", timestamp: t0 }),
      ev({ eventId: "p2", timestamp: t0 + MIN }),
    ]);
    t1.close();
    const t2 = new EngagementTracker(dbPath);
    const r = t2.getDailyReport("R1", "D1", DAY1);
    assert.equal(r.openCount, 1);
    assert.equal(r.avgDwellMs, MIN);
    t2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

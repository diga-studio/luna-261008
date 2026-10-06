import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DownloadAlertTracker,
  type AlertChange,
  type DownloadEvent,
  type Interval,
} from '../src/index.js';

let seq = 0;
function ev(employeeId: string, fileId: string, timestamp: number, eventId?: string): DownloadEvent {
  return { eventId: eventId ?? `e${seq++}`, employeeId, fileId, timestamp };
}

function batch(employeeId: string, fileIds: string[], timestamp: number): DownloadEvent[] {
  return fileIds.map((fileId) => ev(employeeId, fileId, timestamp));
}

function files(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function alertsOf(tracker: DownloadAlertTracker, employeeId: string): string[] {
  return tracker.getAlerts(employeeId).map((iv) => `${iv.start}:${iv.end}`);
}

test('50 files downloaded repeatedly never alert; 51st file opens exact interval', () => {
  const tracker = new DownloadAlertTracker();
  const fifty = files('f', 50);

  // 50 files re-downloaded exactly every 600s: expiry and re-download
  // in the same second keep each file continuously active, still no alert.
  for (const t of [0, 600, 1200, 1800]) {
    const changes = tracker.ingest(batch('emp', fifty, t));
    assert.deepEqual(changes, []);
  }
  assert.deepEqual(alertsOf(tracker, 'emp'), []);

  // The 51st file starts at the same second as many other downloads.
  const changes = tracker.ingest([ev('emp', 'f50', 1800)]);
  assert.deepEqual(changes, [
    { employeeId: 'emp', added: [{ start: 1800, end: 2400 }], removed: [] },
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['1800:2400']);
});

test('exactly 600 seconds apart: file inactive at t+600 without a new download', () => {
  const tracker = new DownloadAlertTracker();
  const fiftyOne = files('f', 51);
  const changes = tracker.ingest(batch('emp', fiftyOne, 1000));
  assert.deepEqual(changes, [
    { employeeId: 'emp', added: [{ start: 1000, end: 1600 }], removed: [] },
  ]);
  // A second employee downloads the same 51 files at t=1600: the first
  // batch expired exactly at 1600, so the count never exceeds 51 there
  // unless files are still active. Each alert is exactly [t, t+600).
  const changes2 = tracker.ingest(batch('emp2', fiftyOne, 1600));
  assert.deepEqual(changes2, [
    { employeeId: 'emp2', added: [{ start: 1600, end: 2200 }], removed: [] },
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['1000:1600']);
  assert.deepEqual(alertsOf(tracker, 'emp2'), ['1600:2200']);
});

test('many files expiring in the same second close the interval exactly', () => {
  const tracker = new DownloadAlertTracker();
  const fiftyOne = files('f', 51);
  // 51 files at t=0, and one extra download of f0 at t=599 (extends only f0).
  tracker.ingest([...batch('emp', fiftyOne, 0), ev('emp', 'f0', 599)]);
  // All 51 active on [0,600); at t=600 fifty of them expire together.
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:600']);
});

test('extending an alert removes the old interval and adds the new one', () => {
  const tracker = new DownloadAlertTracker();
  const fiftyOne = files('f', 51);
  tracker.ingest(batch('emp', fiftyOne, 0));
  const changes = tracker.ingest(batch('emp', fiftyOne, 300));
  assert.deepEqual(changes, [
    { employeeId: 'emp', added: [{ start: 0, end: 900 }], removed: [{ start: 0, end: 600 }] },
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:900']);
});

test('late downloads merge two separate alerts; replay yields no change', () => {
  const tracker = new DownloadAlertTracker();
  const fiftyOne = files('f', 51);

  const c1 = tracker.ingest(batch('emp', fiftyOne, 0));
  assert.deepEqual(c1, [
    { employeeId: 'emp', added: [{ start: 0, end: 600 }], removed: [] },
  ]);
  const c2 = tracker.ingest(batch('emp', fiftyOne, 2000));
  assert.deepEqual(c2, [
    { employeeId: 'emp', added: [{ start: 2000, end: 2600 }], removed: [] },
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:600', '2000:2600']);

  // Late batch bridging the gap: keeps all 51 files active over [600, 2400).
  const late = [
    ...batch('emp', fiftyOne, 600),
    ...batch('emp', fiftyOne, 1200),
    ...batch('emp', fiftyOne, 1800),
  ];
  const c3 = tracker.ingest(late);
  assert.deepEqual(c3, [
    {
      employeeId: 'emp',
      added: [{ start: 0, end: 2600 }],
      removed: [
        { start: 0, end: 600 },
        { start: 2000, end: 2600 },
      ],
    },
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:2600']);

  // Replaying the same batches must not change anything.
  assert.deepEqual(tracker.ingest(late), []);
  assert.deepEqual(tracker.ingest(batch('emp', fiftyOne, 0)), []);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:2600']);
});

test('final state is independent of arrival order and batch splitting', () => {
  const fiftyOne = files('f', 51);
  const all: DownloadEvent[] = [
    ...batch('emp', fiftyOne, 0),
    ...batch('emp', fiftyOne, 2000),
    ...batch('emp', fiftyOne, 600),
    ...batch('emp', fiftyOne, 1200),
    ...batch('emp', fiftyOne, 1800),
  ];

  // Reference: single batch.
  const ref = new DownloadAlertTracker();
  ref.ingest(all);
  const expected = alertsOf(ref, 'emp');
  assert.deepEqual(expected, ['0:2600']);

  // Deterministic shuffle (LCG) and random-ish batch sizes.
  const shuffled = [...all];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const tracker = new DownloadAlertTracker();
  let i = 0;
  while (i < shuffled.length) {
    const size = 1 + Math.floor(rand() * 17);
    tracker.ingest(shuffled.slice(i, i + size));
    i += size;
  }
  assert.deepEqual(alertsOf(tracker, 'emp'), expected);

  // One event per batch, reversed order.
  const reverse = new DownloadAlertTracker();
  for (const e of [...all].reverse()) reverse.ingest([e]);
  assert.deepEqual(alertsOf(reverse, 'emp'), expected);
});

test('duplicate eventIds and same-file downloads never double-count', () => {
  const tracker = new DownloadAlertTracker();
  const fifty = files('f', 50);
  const first = batch('emp', fifty, 0);
  tracker.ingest(first);

  // Same eventIds replayed: empty change.
  assert.deepEqual(tracker.ingest(first), []);

  // New eventIds but already-known files at the same instant: still 50 files.
  const again = batch('emp', fifty, 0);
  assert.deepEqual(tracker.ingest(again), []);
  assert.deepEqual(alertsOf(tracker, 'emp'), []);

  // Whole original batch replayed again after more ingests: still empty.
  assert.deepEqual(tracker.ingest([...first, ...again]), []);
});

test('employees are tracked independently', () => {
  const tracker = new DownloadAlertTracker();
  const fiftyOne = files('f', 51);
  tracker.ingest(batch('a', fiftyOne, 0));
  tracker.ingest(batch('b', fiftyOne, 10000));
  assert.deepEqual(alertsOf(tracker, 'a'), ['0:600']);
  assert.deepEqual(alertsOf(tracker, 'b'), ['10000:10600']);
  assert.deepEqual(tracker.getAlerts('nobody'), []);
});

test('simultaneous expiry and download at the threshold keeps one unbroken interval', () => {
  const tracker = new DownloadAlertTracker();
  const stay = files('stay', 50);
  // 50 files stay active across t=600 via re-download; f-out expires at 600
  // exactly when f-in starts. The count never dips below 51, so the alert
  // is a single interval [0, 1200) with no break at t=600.
  tracker.ingest([
    ...batch('emp', stay, 0),
    ...batch('emp', stay, 600),
    ev('emp', 'f-out', 0),
    ev('emp', 'f-in', 600),
  ]);
  assert.deepEqual(alertsOf(tracker, 'emp'), ['0:1200']);
});

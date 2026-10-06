import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, AlertService, isInSilentWindow } from '../src/index.js';
import type { NotificationRecord } from '../src/index.js';

const HOUR = 3_600_000;
const MIN = 60_000;

/** Wall clock in UTC+8 on Jan 2026, returned as UTC epoch ms. */
function at(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 0, day, hour, minute) - 8 * HOUR;
}

function makeService(): AlertService {
  return new AlertService(openDatabase(':memory:'));
}

function registerNegativeStreak(
  svc: AlertService,
  callId: string,
  startIndex: number,
  count: number,
  startTime: number,
  stepMs = MIN,
): void {
  for (let i = 0; i < count; i += 1) {
    svc.registerSegment({
      callId,
      segmentIndex: startIndex + i,
      score: -0.6,
      businessTime: startTime + i * stepMs,
    });
  }
}

function summary(list: NotificationRecord[]): string[] {
  return list.map((n) => `${n.level}@${n.publishedAt}`);
}

test('silent window boundaries: [22:00, 06:00) in UTC+8', () => {
  assert.equal(isInSilentWindow(at(2, 22, 0)), true);
  assert.equal(isInSilentWindow(at(2, 23, 59)), true);
  assert.equal(isInSilentWindow(at(2, 5, 59)), true);
  assert.equal(isInSilentWindow(at(2, 6, 0)), false);
  assert.equal(isInSilentWindow(at(2, 21, 59)), false);
});

test('creates an INFO alert on the third consecutive negative segment', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 2, at(2, 10, 0));
  assert.equal(svc.listAlerts().length, 0);
  svc.registerSegment({ callId: 'c1', segmentIndex: 2, score: -0.6, businessTime: at(2, 10, 2) });
  const alerts = svc.listAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.level, 'INFO');
  assert.equal(alerts[0]!.createdAt, at(2, 10, 2));
  assert.deepEqual(summary(svc.listNotifications()), [`INFO@${at(2, 10, 2)}`]);
});

test('score of exactly -0.5 is not negative and resets the streak', () => {
  const svc = makeService();
  const scores = [-0.6, -0.5, -0.6, -0.6, -0.6];
  scores.forEach((score, i) => {
    svc.registerSegment({ callId: 'c1', segmentIndex: i, score, businessTime: at(2, 10, i) });
  });
  const alerts = svc.listAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.createdAt, at(2, 10, 4));
});

test('duplicate segment deliveries are ignored', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0));
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0));
  svc.registerSegment({ callId: 'c1', segmentIndex: 1, score: -0.6, businessTime: at(2, 10, 1) });
  assert.equal(svc.listAlerts().length, 1);
  assert.equal(svc.listNotifications().length, 1);
});

test('continued negatives after the third do not create more alerts', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 6, at(2, 10, 0));
  assert.equal(svc.listAlerts().length, 1);
});

test('separate negative streaks produce independent alerts', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0));
  svc.registerSegment({ callId: 'c1', segmentIndex: 3, score: 0.2, businessTime: at(2, 10, 3) });
  registerNegativeStreak(svc, 'c1', 4, 3, at(2, 10, 4));
  const alerts = svc.listAlerts('c1');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0]!.createdAt, at(2, 10, 2));
  assert.equal(alerts[1]!.createdAt, at(2, 10, 6));
});

test('unconfirmed alerts escalate to WARN after 15min and CRITICAL after 30min', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0), 0);
  const alertId = svc.listAlerts()[0]!.id;
  svc.advanceTime(at(2, 10, 14));
  assert.equal(svc.getAlert(alertId)!.level, 'INFO');
  svc.advanceTime(at(2, 10, 15));
  assert.equal(svc.getAlert(alertId)!.level, 'WARN');
  svc.advanceTime(at(2, 10, 29));
  assert.deepEqual(summary(svc.listNotifications()), [
    `INFO@${at(2, 10, 0)}`,
    `WARN@${at(2, 10, 15)}`,
  ]);
  svc.advanceTime(at(2, 10, 30));
  assert.equal(svc.getAlert(alertId)!.level, 'CRITICAL');
  assert.deepEqual(summary(svc.listNotifications()), [
    `INFO@${at(2, 10, 0)}`,
    `WARN@${at(2, 10, 15)}`,
    `CRITICAL@${at(2, 10, 30)}`,
  ]);
});

test('one big time jump equals stepping through each node', () => {
  const stepped = makeService();
  registerNegativeStreak(stepped, 'c1', 0, 3, at(2, 5, 40));
  for (const t of [at(2, 5, 55), at(2, 6, 0), at(2, 6, 10), at(2, 6, 20)]) {
    stepped.advanceTime(t);
  }
  const jumped = makeService();
  registerNegativeStreak(jumped, 'c1', 0, 3, at(2, 5, 40));
  jumped.advanceTime(at(2, 6, 20));
  assert.deepEqual(summary(jumped.listNotifications()), summary(stepped.listNotifications()));
});

test('alert created at 5:40, jumped to 6:20: only WARN@6:00 and CRITICAL@6:10', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 5, 40), 0);
  svc.advanceTime(at(2, 6, 20));
  assert.deepEqual(summary(svc.listNotifications()), [
    `WARN@${at(2, 6, 0)}`,
    `CRITICAL@${at(2, 6, 10)}`,
  ]);
});

test('confirming at 5:58 prevents both pending notifications', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 5, 40), 0);
  const alertId = svc.listAlerts()[0]!.id;
  svc.confirmAlert(alertId, at(2, 5, 58));
  svc.advanceTime(at(2, 6, 20));
  assert.deepEqual(svc.listNotifications(), []);
  assert.equal(svc.getAlert(alertId)!.confirmedAt, at(2, 5, 58));
});

test('silent window suppresses INFO/WARN but publishes CRITICAL', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 22, 30), 0);
  svc.advanceTime(at(2, 23, 0));
  assert.deepEqual(summary(svc.listNotifications()), [`CRITICAL@${at(2, 23, 0)}`]);
  svc.advanceTime(at(3, 7, 0));
  assert.equal(svc.listNotifications().length, 1);
});

test('silent-window end publishes only the then-current level', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 5, 50), 0);
  svc.advanceTime(at(2, 6, 20));
  assert.deepEqual(summary(svc.listNotifications()), [
    `INFO@${at(2, 6, 0)}`,
    `WARN@${at(2, 6, 5)}`,
    `CRITICAL@${at(2, 6, 20)}`,
  ]);
});

test('confirming exactly at an upgrade moment keeps that moment notification', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0), 0);
  const alertId = svc.listAlerts()[0]!.id;
  svc.confirmAlert(alertId, at(2, 10, 15));
  assert.deepEqual(summary(svc.listNotifications()), [
    `INFO@${at(2, 10, 0)}`,
    `WARN@${at(2, 10, 15)}`,
  ]);
  svc.advanceTime(at(2, 12, 0));
  assert.equal(svc.listNotifications().length, 2);
  assert.equal(svc.getAlert(alertId)!.level, 'WARN');
});

test('confirm stops escalation but keeps existing notifications', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0), 0);
  const alertId = svc.listAlerts()[0]!.id;
  svc.advanceTime(at(2, 10, 15));
  svc.confirmAlert(alertId, at(2, 10, 20));
  svc.advanceTime(at(2, 12, 0));
  const status = svc.getAlertStatus(alertId)!;
  assert.equal(status.alert.level, 'WARN');
  assert.equal(status.notifications.length, 2);
});

test('confirming a confirmed or unknown alert is safe', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0));
  const alertId = svc.listAlerts()[0]!.id;
  svc.confirmAlert(alertId, at(2, 10, 1));
  svc.confirmAlert(alertId, at(2, 10, 2));
  assert.equal(svc.getAlert(alertId)!.confirmedAt, at(2, 10, 1));
  assert.throws(() => svc.confirmAlert('missing', at(2, 10, 3)), /alert not found/);
});

test('repeated time advances and reads do not change state', () => {
  const svc = makeService();
  registerNegativeStreak(svc, 'c1', 0, 3, at(2, 10, 0), 0);
  svc.advanceTime(at(2, 10, 30));
  svc.advanceTime(at(2, 10, 30));
  svc.advanceTime(at(2, 10, 10));
  const first = svc.listNotifications();
  const second = svc.listNotifications();
  assert.deepEqual(summary(first), summary(second));
  assert.equal(first.length, 3);
  const alertId = svc.listAlerts()[0]!.id;
  assert.deepEqual(svc.getAlertStatus(alertId), svc.getAlertStatus(alertId));
});

test('state persists across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentiment-alert-'));
  const file = join(dir, 'state.db');
  const svc1 = new AlertService(openDatabase(file));
  registerNegativeStreak(svc1, 'c1', 0, 3, at(2, 10, 0), 0);
  svc1.advanceTime(at(2, 10, 15));
  const alertId = svc1.listAlerts()[0]!.id;
  const svc2 = new AlertService(openDatabase(file));
  const status = svc2.getAlertStatus(alertId)!;
  assert.equal(status.alert.level, 'WARN');
  assert.deepEqual(summary(status.notifications), [
    `INFO@${at(2, 10, 0)}`,
    `WARN@${at(2, 10, 15)}`,
  ]);
  svc2.confirmAlert(alertId, at(2, 10, 20));
  svc2.advanceTime(at(2, 12, 0));
  assert.equal(svc2.listNotifications().length, 2);
});

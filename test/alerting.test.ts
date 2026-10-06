import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertingService } from '../src/index.js';
import type { NotificationRecord } from '../src/index.js';

/** 以 2026-01-10（Asia/Shanghai）为基准日，返回 UTC+8 当日 hour:minute 的 UTC 毫秒 */
function cst(dayOffset: number, hour: number, minute: number): number {
  return Date.UTC(2026, 0, 10 + dayOffset, hour - 8, minute);
}

function neg(score = -0.6): number {
  return score;
}

function registerNegativeSegments(
  svc: AlertingService,
  callId: string,
  fromSeq: number,
  count: number,
  time: number,
): void {
  for (let i = 0; i < count; i++) {
    svc.registerSegment({ callId, segmentSeq: fromSeq + i, score: neg(), businessTime: time });
  }
}

function summary(notifications: NotificationRecord[]): Array<[string, number]> {
  return notifications.map((n) => [n.level, n.occurredAt] as [string, number]);
}

test('连续第三个负面分段创建信息级告警，之前不创建', () => {
  const svc = new AlertingService(':memory:');
  const t = cst(0, 10, 0);
  const r1 = svc.registerSegment({ callId: 'c1', segmentSeq: 1, score: neg(), businessTime: t });
  const r2 = svc.registerSegment({ callId: 'c1', segmentSeq: 2, score: neg(), businessTime: t });
  const r3 = svc.registerSegment({ callId: 'c1', segmentSeq: 3, score: neg(), businessTime: t });
  assert.equal(r1.createdAlert, null);
  assert.equal(r2.createdAlert, null);
  assert.ok(r3.createdAlert);
  assert.equal(r3.createdAlert.level, 'INFO');
  assert.equal(r3.createdAlert.createdAt, t);

  const alerts = svc.getAlerts('c1');
  assert.equal(alerts.length, 1);
  assert.deepEqual(summary(svc.getNotifications('c1')), [['INFO', t]]);
  svc.close();
});

test('评分大于等于 -0.5 重置计数；不同负面连续段产生独立告警', () => {
  const svc = new AlertingService(':memory:');
  const t = cst(0, 10, 0);
  // -0.5 不算负面（严格小于才算）
  const scores = [neg(), neg(), -0.5, neg(), neg(), neg(), neg(), 0.1, neg(), neg(), neg()];
  const created: string[] = [];
  scores.forEach((score, i) => {
    const r = svc.registerSegment({ callId: 'c1', segmentSeq: i + 1, score, businessTime: t + i });
    if (r.createdAlert) created.push(r.createdAlert.alertId);
  });
  assert.equal(created.length, 2);
  const alerts = svc.getAlerts('c1');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0]!.createdAt, t + 5);
  assert.equal(alerts[1]!.createdAt, t + 10);
  svc.close();
});

test('重复投递相同分段幂等：不产生告警与通知变化', () => {
  const svc = new AlertingService(':memory:');
  const t = cst(0, 10, 0);
  for (let seq = 1; seq <= 3; seq++) {
    svc.registerSegment({ callId: 'c1', segmentSeq: seq, score: neg(), businessTime: t });
  }
  const before = svc.getNotifications('c1');
  // 重复投递全部三个分段
  for (let seq = 1; seq <= 3; seq++) {
    const r = svc.registerSegment({ callId: 'c1', segmentSeq: seq, score: neg(), businessTime: t });
    assert.equal(r.createdAlert, null);
  }
  assert.equal(svc.getAlerts('c1').length, 1);
  assert.deepEqual(svc.getNotifications('c1'), before);
  svc.close();
});

test('未确认告警 15 分钟升警告、30 分钟升严重，通知记录逻辑时间', () => {
  const svc = new AlertingService(':memory:');
  const t0 = cst(0, 10, 0);
  registerNegativeSegments(svc, 'c1', 1, 3, t0);
  svc.advanceTime(cst(0, 10, 45));
  const alerts = svc.getAlerts('c1');
  assert.equal(alerts[0]!.level, 'CRITICAL');
  assert.deepEqual(summary(svc.getNotifications('c1')), [
    ['INFO', cst(0, 10, 0)],
    ['WARNING', cst(0, 10, 15)],
    ['CRITICAL', cst(0, 10, 30)],
  ]);
  // 重复推进不产生新通知
  svc.advanceTime(cst(0, 10, 45));
  svc.advanceTime(cst(0, 12, 0));
  assert.equal(svc.getNotifications('c1').length, 3);
  svc.close();
});

test('确认停止后续升级与通知，不删除已有通知', () => {
  const svc = new AlertingService(':memory:');
  const t0 = cst(0, 10, 0);
  registerNegativeSegments(svc, 'c1', 1, 3, t0);
  const alertId = svc.getAlerts('c1')[0]!.alertId;
  svc.acknowledgeAlert({ alertId, businessTime: cst(0, 10, 16) });
  svc.advanceTime(cst(0, 12, 0));
  const alert = svc.getAlerts('c1')[0]!;
  assert.equal(alert.level, 'WARNING');
  assert.equal(alert.acknowledgedAt, cst(0, 10, 16));
  assert.deepEqual(summary(svc.getNotifications('c1')), [
    ['INFO', cst(0, 10, 0)],
    ['WARNING', cst(0, 10, 15)],
  ]);
  // 重复确认幂等
  svc.acknowledgeAlert({ alertId, businessTime: cst(0, 12, 0) });
  assert.equal(svc.getAlerts('c1')[0]!.acknowledgedAt, cst(0, 10, 16));
  svc.close();
});

test('恰好在升级时刻确认，不能撤销该时刻已产生的通知', () => {
  const svc = new AlertingService(':memory:');
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 10, 0));
  const alertId = svc.getAlerts('c1')[0]!.alertId;
  svc.acknowledgeAlert({ alertId, businessTime: cst(0, 10, 15) });
  svc.advanceTime(cst(0, 12, 0));
  assert.deepEqual(summary(svc.getNotifications('c1')), [
    ['INFO', cst(0, 10, 0)],
    ['WARNING', cst(0, 10, 15)],
  ]);
  assert.equal(svc.getAlerts('c1')[0]!.level, 'WARNING');
  svc.close();
});

test('确认不影响该通话之后的新告警', () => {
  const svc = new AlertingService(':memory:');
  const t0 = cst(0, 10, 0);
  registerNegativeSegments(svc, 'c1', 1, 3, t0);
  const first = svc.getAlerts('c1')[0]!;
  svc.acknowledgeAlert({ alertId: first.alertId, businessTime: t0 + 1000 });
  // 一个非负面分段重置后，再来三个负面分段 -> 新告警
  svc.registerSegment({ callId: 'c1', segmentSeq: 4, score: 0.3, businessTime: t0 + 2000 });
  registerNegativeSegments(svc, 'c1', 5, 3, t0 + 3000);
  const alerts = svc.getAlerts('c1');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1]!.acknowledgedAt, null);
  svc.close();
});

test('静默窗口抑制信息与警告通知，严重级照常发布', () => {
  const svc = new AlertingService(':memory:');
  // UTC+8 23:00 创建（窗口内）
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 23, 0));
  assert.deepEqual(summary(svc.getNotifications('c1')), []);
  // 23:15 升警告（被抑制）；23:30 升严重（照常发布）
  svc.advanceTime(cst(1, 0, 0));
  assert.deepEqual(summary(svc.getNotifications('c1')), [['CRITICAL', cst(0, 23, 30)]]);
  // 静默结束后无新增（严重级已发布，此前被抑制的等级跳过）
  svc.advanceTime(cst(1, 8, 0));
  assert.deepEqual(summary(svc.getNotifications('c1')), [['CRITICAL', cst(0, 23, 30)]]);
  svc.close();
});

test('题目场景一：5:40 创建直接推进到 6:20，只产生 6:00 警告与 6:10 严重', () => {
  const svc = new AlertingService(':memory:');
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 5, 40));
  svc.advanceTime(cst(0, 6, 20));
  assert.deepEqual(summary(svc.getNotifications('c1')), [
    ['WARNING', cst(0, 6, 0)],
    ['CRITICAL', cst(0, 6, 10)],
  ]);
  svc.close();
});

test('题目场景二：5:40 创建、5:58 确认，推进到 6:20 不产生任何通知', () => {
  const svc = new AlertingService(':memory:');
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 5, 40));
  const alertId = svc.getAlerts('c1')[0]!.alertId;
  svc.acknowledgeAlert({ alertId, businessTime: cst(0, 5, 58) });
  svc.advanceTime(cst(0, 6, 20));
  assert.deepEqual(svc.getNotifications('c1'), []);
  assert.equal(svc.getAlerts('c1')[0]!.level, 'WARNING');
  svc.close();
});

test('一次推进跨多个节点与逐个节点推进结果一致', () => {
  const oneShot = new AlertingService(':memory:');
  const stepwise = new AlertingService(':memory:');
  // 跨静默边界的场景：21:50 创建（信息可发布），22:05 警告被抑制，22:20 严重照常
  for (const svc of [oneShot, stepwise]) {
    registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 21, 50));
  }
  oneShot.advanceTime(cst(1, 12, 0));
  for (const t of [cst(0, 22, 5), cst(0, 22, 20), cst(1, 6, 0), cst(1, 12, 0)]) {
    stepwise.advanceTime(t);
  }
  assert.deepEqual(summary(oneShot.getNotifications('c1')), summary(stepwise.getNotifications('c1')));
  const stripIds = (alerts: Array<{ level: string; createdAt: number; acknowledgedAt: number | null }>) =>
    alerts.map((a) => ({ level: a.level, createdAt: a.createdAt, acknowledgedAt: a.acknowledgedAt }));
  assert.deepEqual(stripIds(oneShot.getAlerts('c1')), stripIds(stepwise.getAlerts('c1')));
  oneShot.close();
  stepwise.close();
});

test('静默结束只补发当时等级，跳过被抑制的等级', () => {
  const svc = new AlertingService(':memory:');
  // 5:40 创建：信息被抑制；5:55 警告被抑制；6:00 补发警告；6:10 严重照常
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 5, 40));
  svc.advanceTime(cst(0, 5, 56));
  assert.deepEqual(summary(svc.getNotifications('c1')), []);
  svc.advanceTime(cst(0, 7, 0));
  assert.deepEqual(summary(svc.getNotifications('c1')), [
    ['WARNING', cst(0, 6, 0)],
    ['CRITICAL', cst(0, 6, 10)],
  ]);
  svc.close();
});

test('读取不消费通知', () => {
  const svc = new AlertingService(':memory:');
  registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 10, 0));
  const first = svc.getNotifications('c1');
  const second = svc.getNotifications('c1');
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  svc.close();
});

test('业务时间倒退抛错', () => {
  const svc = new AlertingService(':memory:');
  svc.advanceTime(cst(0, 10, 0));
  assert.throws(() => svc.advanceTime(cst(0, 9, 0)));
  svc.close();
});

test('状态与通知持久化到 SQLite，重开后保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerting-'));
  try {
    const dbPath = join(dir, 'state.db');
    const svc = new AlertingService(dbPath);
    registerNegativeSegments(svc, 'c1', 1, 3, cst(0, 10, 0));
    svc.advanceTime(cst(0, 10, 20));
    svc.close();

    const reopened = new AlertingService(dbPath);
    assert.equal(reopened.getAlerts('c1').length, 1);
    assert.equal(reopened.getAlerts('c1')[0]!.level, 'WARNING');
    assert.deepEqual(summary(reopened.getNotifications('c1')), [
      ['INFO', cst(0, 10, 0)],
      ['WARNING', cst(0, 10, 15)],
    ]);
    // 重开后重复投递旧分段仍幂等
    reopened.registerSegment({ callId: 'c1', segmentSeq: 3, score: neg(), businessTime: cst(0, 10, 20) });
    assert.equal(reopened.getAlerts('c1').length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

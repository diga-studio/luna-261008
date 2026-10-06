import type { DatabaseSync } from 'node:sqlite';
import type { AvailabilityReport } from './types.js';

interface TunnelRow {
  id: string;
  iface_a: string;
  iface_b: string;
}

interface RecordRow {
  object_type: string;
  object_id: string;
  seq: number;
  biz_time: number;
  state: string;
}

/**
 * 生成站点对 [windowStart, windowEnd) 的可用率报告。
 * 结果等同于把调用前已接收的全部记录按业务时间重放：
 * 窗口开始前的最后状态延续进窗口，窗口内按 (biz_time, seq) 顺序应用事件。
 */
export function generateReport(
  db: DatabaseSync,
  siteA: string,
  siteB: string,
  windowStart: number,
  windowEnd: number,
): AvailabilityReport {
  if (!Number.isInteger(windowStart) || !Number.isInteger(windowEnd) || windowStart >= windowEnd) {
    throw new RangeError('require integer windowStart < windowEnd');
  }

  const tunnels = db
    .prepare(
      `SELECT id, iface_a, iface_b FROM tunnels
       WHERE (site_a = ? AND site_b = ?) OR (site_a = ? AND site_b = ?)`,
    )
    .all(siteA, siteB, siteB, siteA) as unknown as TunnelRow[];

  const empty: AvailabilityReport = {
    siteA,
    siteB,
    windowStart,
    windowEnd,
    connectedMs: 0,
    availability: 0,
  };
  if (tunnels.length === 0) {
    return empty;
  }

  const objectKeys: string[] = [];
  for (const t of tunnels) {
    objectKeys.push(`tunnel:${t.id}`, `interface:${t.iface_a}`, `interface:${t.iface_b}`);
  }
  const placeholders = objectKeys.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT object_type, object_id, seq, biz_time, state FROM records
       WHERE biz_time < ? AND (object_type || ':' || object_id) IN (${placeholders})
       ORDER BY biz_time ASC, seq ASC`,
    )
    .all(windowEnd, ...objectKeys) as unknown as RecordRow[];

  // 每个对象的当前可用性；首条记录之前一律不可用。
  const available = new Map<string, boolean>();
  const isAvailable = (objectType: string, state: string): boolean =>
    objectType === 'interface' ? state === 'up' : state === 'Active';

  const applyEvent = (row: RecordRow): void => {
    available.set(`${row.object_type}:${row.object_id}`, isAvailable(row.object_type, row.state));
  };

  const isConnected = (): boolean =>
    tunnels.some(
      (t) =>
        available.get(`tunnel:${t.id}`) === true &&
        available.get(`interface:${t.iface_a}`) === true &&
        available.get(`interface:${t.iface_b}`) === true,
    );

  // 窗口起点（含）的状态：应用所有 biz_time <= windowStart 的事件。
  let cursor = 0;
  while (cursor < rows.length && rows[cursor].biz_time <= windowStart) {
    applyEvent(rows[cursor]);
    cursor += 1;
  }

  // 扫描线：同一毫秒的事件整批应用后再进入下一段，避免虚假间隙。
  let connectedMs = 0;
  let prevTime = windowStart;
  while (cursor < rows.length) {
    const eventTime = rows[cursor].biz_time;
    if (isConnected()) {
      connectedMs += eventTime - prevTime;
    }
    while (cursor < rows.length && rows[cursor].biz_time === eventTime) {
      applyEvent(rows[cursor]);
      cursor += 1;
    }
    prevTime = eventTime;
  }
  if (isConnected()) {
    connectedMs += windowEnd - prevTime;
  }

  return {
    siteA,
    siteB,
    windowStart,
    windowEnd,
    connectedMs,
    availability: connectedMs / (windowEnd - windowStart),
  };
}

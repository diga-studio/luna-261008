import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { addInterface, addTunnel } from './topology.js';
import { appendRecord } from './records.js';
import { generateReport } from './report.js';
import type { AvailabilityReport, StateRecord } from './types.js';

export * from './types.js';

/** 隧道可用率统计库的门面类，供上层报表任务调用。 */
export class TunnelAvailability {
  private readonly db: DatabaseSync;

  /** @param path SQLite 文件路径；传 ':memory:' 使用内存库。 */
  constructor(path: string) {
    this.db = openDatabase(path);
  }

  addInterface(interfaceId: string): void {
    addInterface(this.db, interfaceId);
  }

  addTunnel(
    tunnelId: string,
    siteA: string,
    siteB: string,
    ifaceA: string,
    ifaceB: string,
  ): void {
    addTunnel(this.db, tunnelId, siteA, siteB, ifaceA, ifaceB);
  }

  appendRecord(record: StateRecord): void {
    appendRecord(this.db, record);
  }

  report(siteA: string, siteB: string, windowStart: number, windowEnd: number): AvailabilityReport {
    return generateReport(this.db, siteA, siteB, windowStart, windowEnd);
  }

  close(): void {
    this.db.close();
  }
}

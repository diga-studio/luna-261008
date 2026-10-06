import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { Store } from "./store";
import { computeReport } from "./report";
import { AvailabilityReport, StatusRecord, TunnelDefinition } from "./types";

export * from "./types";

/** Public entry point for reporting tasks. */
export class TunnelAvailabilityLibrary {
  private readonly db: DatabaseSync;
  private readonly store: Store;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.store = new Store(this.db);
  }

  addTunnel(def: TunnelDefinition): void {
    this.store.addTunnel(def);
  }

  addStatusRecord(record: StatusRecord): void {
    this.store.addStatusRecord(record);
  }

  report(
    siteA: string,
    siteB: string,
    windowStartMs: number,
    windowEndMs: number
  ): AvailabilityReport {
    return computeReport(this.db, siteA, siteB, windowStartMs, windowEndMs);
  }

  close(): void {
    this.db.close();
  }
}

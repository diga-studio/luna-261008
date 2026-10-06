import { DatabaseSync } from "node:sqlite";
import { StatusRecord, TunnelDefinition } from "./types";

/** Persists fixed topology and deduplicated status records. */
export class Store {
  constructor(private readonly db: DatabaseSync) {}

  /** Register the fixed topology. Must be called before records arrive. */
  addTunnel(def: TunnelDefinition): void {
    this.db
      .prepare(
        `INSERT INTO tunnels (tunnel_id, site_a, site_b, interface_a, interface_b)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(def.tunnelId, def.siteA, def.siteB, def.interfaceA, def.interfaceB);
  }

  /** Ingest one status record. Duplicates (same recordId) are ignored. */
  addStatusRecord(record: StatusRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO status_records
           (record_id, object_id, object_kind, ts_ms, seq, state)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.recordId,
        record.objectId,
        record.objectKind,
        record.timestampMs,
        record.seq,
        record.state
      );
  }
}

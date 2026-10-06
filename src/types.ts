/** A single ingested event. employeeId is a random opaque identifier. */
export interface EvidenceEvent {
  /** UTC timestamp, ISO 8601 string. */
  timestamp: string;
  eventType: string;
  metadata: unknown;
}

/** Per-UTC-date, per-eventType event counts. */
export type DailySummary = Record<string, Record<string, number>>;

export interface EmployeeEvidence {
  employeeId: string;
  events: EvidenceEvent[];
  summaries: DailySummary;
}

export type AuditItemType = "ingest" | "erase";

export interface AuditItem {
  /** Monotonic sequence number, starts at 1, immutable once committed. */
  seq: number;
  type: AuditItemType;
  employeeId: string;
  /**
   * ingest: encrypted self-contained payload (full events + updated summary).
   * erase: no sensitive payload, only structural fields.
   */
  payloadCiphertext: string | null;
  /** Hash of previous item (hex), "0".repeat(64) for the first item. */
  prevHash: string;
  /** Hash of this item over (seq, type, employeeId, payloadCiphertext, prevHash). */
  hash: string;
}

export interface AuditEntryView {
  seq: number;
  type: AuditItemType;
  employeeId: string;
  hash: string;
  prevHash: string;
  /** Decrypted payload when the component still holds the key; null otherwise. */
  payload: unknown;
}

export interface AuditReport {
  items: AuditEntryView[];
  integrityOk: boolean;
  integrityError: string | null;
}

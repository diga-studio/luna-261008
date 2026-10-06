export interface EvidenceEvent {
  /** UTC timestamp, ISO 8601 */
  timestamp: string;
  eventType: string;
  metadata: unknown;
}

/** UTC date (YYYY-MM-DD) -> eventType -> count */
export interface DailySummary {
  [utcDate: string]: {
    [eventType: string]: number;
  };
}

export interface EmployeeRecord {
  events: EvidenceEvent[];
  summaries: DailySummary;
}

export type AuditEntryType = "ingest" | "erase-complete";

/** Self-contained sensitive payload of an ingest audit entry (stored encrypted). */
export interface IngestAuditPayload {
  events: EvidenceEvent[];
  summaries: DailySummary;
}

export interface AuditEntry {
  seq: number;
  prevHash: string;
  type: AuditEntryType;
  employeeId: string;
  /** base64 encrypted IngestAuditPayload for ingest entries; null for erase-complete */
  payload: string | null;
  hash: string;
}

export interface AuditViewEntry {
  seq: number;
  prevHash: string;
  hash: string;
  type: AuditEntryType;
  employeeId: string;
  /** decrypted payload when this component still holds the key, otherwise null */
  payload: IngestAuditPayload | null;
  /** true when the payload is undecryptable because the employee was erased */
  payloadDestroyed: boolean;
}

export interface AuditInspection {
  intact: boolean;
  problems: string[];
  entries: AuditViewEntry[];
}

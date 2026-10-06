import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { AuditLog } from "./audit";
import { decryptJson, encryptJson, generateKey } from "./crypto";
import {
  AuditInspection,
  AuditViewEntry,
  DailySummary,
  EmployeeRecord,
  EvidenceEvent,
  IngestAuditPayload,
} from "./types";

export interface EvidenceStoreOptions {
  /** Test hook: invoked after each erase persistence boundary, before the next one. */
  onEraseBoundary?: (step: string) => void;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Local employee evidence store.
 *
 * Confidentiality vs. audit immutability is resolved by crypto-shredding:
 * every employee's evidence (data file and self-contained ingest audit
 * payloads) is encrypted under a per-employee random key. Erasure destroys
 * the key and the data file, leaving the committed audit entries byte-for-byte
 * intact but permanently undecryptable.
 */
export class EvidenceStore {
  private readonly dir: string;
  private readonly auditLog: AuditLog;
  private readonly tombstones: Set<string>;
  private readonly onEraseBoundary?: (step: string) => void;

  private constructor(dir: string, options?: EvidenceStoreOptions) {
    this.dir = dir;
    this.onEraseBoundary = options?.onEraseBoundary;
    for (const sub of ["keys", "data", "tombstones", "erase-pending"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    this.auditLog = new AuditLog(join(dir, "audit.log"));
    this.tombstones = new Set(
      readdirSync(join(dir, "tombstones")).filter((name) => ID_PATTERN.test(name))
    );
    // Recovery: any erase that produced persistent progress is finished now,
    // before reads and writes are opened.
    for (const name of readdirSync(join(dir, "erase-pending"))) {
      if (ID_PATTERN.test(name)) {
        this.performErase(name);
      }
    }
  }

  /** Open (or create) the store rooted at dir, completing any interrupted erase first. */
  static open(dir: string, options?: EvidenceStoreOptions): EvidenceStore {
    return new EvidenceStore(dir, options);
  }

  ingest(employeeId: string, events: EvidenceEvent[]): void {
    assertValidId(employeeId);
    if (this.tombstones.has(employeeId)) {
      throw new Error(`employee ${employeeId} has been permanently erased`);
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("events must be a non-empty array");
    }
    for (const event of events) {
      validateEvent(event);
    }
    const key = this.loadOrCreateKey(employeeId);
    const record = this.readRecord(employeeId, key);
    for (const event of events) {
      record.events.push(event);
      const day = utcDay(event.timestamp);
      const byType = (record.summaries[day] = record.summaries[day] || {});
      byType[event.eventType] = (byType[event.eventType] || 0) + 1;
    }
    writeFileSync(this.dataPath(employeeId), encryptJson(key, record), "utf8");
    const payload: IngestAuditPayload = {
      events,
      summaries: record.summaries,
    };
    this.auditLog.append("ingest", employeeId, encryptJson(key, payload));
  }

  readEmployee(employeeId: string): EmployeeRecord {
    assertValidId(employeeId);
    if (this.tombstones.has(employeeId)) {
      return { events: [], summaries: {} };
    }
    const key = this.loadKey(employeeId);
    if (!key) {
      return { events: [], summaries: {} };
    }
    return this.readRecord(employeeId, key);
  }

  eraseEmployee(employeeId: string): void {
    assertValidId(employeeId);
    if (this.tombstones.has(employeeId)) {
      // Already erased: idempotent, never a second erase-complete audit entry.
      return;
    }
    this.performErase(employeeId);
  }

  inspectAudit(): AuditInspection {
    const problems = this.auditLog.verify();
    const entries: AuditViewEntry[] = [];
    for (const entry of this.auditLog.readAll()) {
      const view: AuditViewEntry = {
        seq: entry.seq,
        prevHash: entry.prevHash,
        hash: entry.hash,
        type: entry.type,
        employeeId: entry.employeeId,
        payload: null,
        payloadDestroyed: false,
      };
      if (entry.type === "ingest" && entry.payload !== null) {
        const key = this.loadKey(entry.employeeId);
        if (!key) {
          view.payloadDestroyed = true;
        } else {
          try {
            view.payload = decryptJson(key, entry.payload) as IngestAuditPayload;
          } catch {
            problems.push(`entry ${entry.seq}: payload undecryptable`);
          }
        }
      }
      entries.push(view);
    }
    return { intact: problems.length === 0, problems, entries };
  }

  /**
   * Idempotent erase procedure. Each step is a persistence boundary;
   * the pending marker written first guarantees recovery completes the
   * erase after any interruption.
   */
  private performErase(employeeId: string): void {
    this.boundary("start");
    writeFileSync(this.pendingPath(employeeId), "", "utf8");
    this.boundary("pending");
    unlinkIfExists(this.keyPath(employeeId));
    this.boundary("key");
    unlinkIfExists(this.dataPath(employeeId));
    this.boundary("data");
    writeFileSync(this.tombstonePath(employeeId), "", "utf8");
    this.tombstones.add(employeeId);
    this.boundary("tombstone");
    if (!this.auditLog.hasEraseComplete(employeeId)) {
      this.auditLog.append("erase-complete", employeeId, null);
    }
    this.boundary("audit");
    unlinkIfExists(this.pendingPath(employeeId));
    this.boundary("done");
  }

  private boundary(step: string): void {
    if (this.onEraseBoundary) {
      this.onEraseBoundary(step);
    }
  }

  private loadOrCreateKey(employeeId: string): Buffer {
    const existing = this.loadKey(employeeId);
    if (existing) {
      return existing;
    }
    const key = generateKey();
    writeFileSync(this.keyPath(employeeId), key.toString("hex"), "utf8");
    return key;
  }

  private loadKey(employeeId: string): Buffer | null {
    const path = this.keyPath(employeeId);
    if (!existsSync(path)) {
      return null;
    }
    return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  }

  private readRecord(employeeId: string, key: Buffer): EmployeeRecord {
    const path = this.dataPath(employeeId);
    if (!existsSync(path)) {
      return { events: [], summaries: {} };
    }
    return decryptJson(key, readFileSync(path, "utf8")) as EmployeeRecord;
  }

  private keyPath(employeeId: string): string {
    return join(this.dir, "keys", `${employeeId}.key`);
  }

  private dataPath(employeeId: string): string {
    return join(this.dir, "data", `${employeeId}.enc`);
  }

  private tombstonePath(employeeId: string): string {
    return join(this.dir, "tombstones", employeeId);
  }

  private pendingPath(employeeId: string): string {
    return join(this.dir, "erase-pending", employeeId);
  }
}

function assertValidId(employeeId: string): void {
  if (!ID_PATTERN.test(employeeId)) {
    throw new Error(`invalid employeeId: ${JSON.stringify(employeeId)}`);
  }
}

function validateEvent(event: EvidenceEvent): void {
  if (!event || typeof event !== "object") {
    throw new Error("event must be an object");
  }
  if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) {
    throw new Error(`invalid event timestamp: ${JSON.stringify(event.timestamp)}`);
  }
  if (typeof event.eventType !== "string" || event.eventType.length === 0) {
    throw new Error("eventType must be a non-empty string");
  }
}

function utcDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

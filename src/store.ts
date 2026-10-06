import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AuditLog } from "./auditLog.js";
import { crashBoundary } from "./crashHook.js";
import { decryptJson, encryptJson, generateDataKey, type DataKey } from "./crypto.js";
import type {
  AuditEntryView,
  AuditReport,
  DailySummary,
  EmployeeEvidence,
  EvidenceEvent,
} from "./types.js";

export interface EvidenceStoreOptions {
  /** Directory that holds all persisted state. Created if missing. */
  dir: string;
}

interface EmployeeState {
  events: EvidenceEvent[];
  summaries: DailySummary;
}

interface IngestAuditPayload {
  events: EvidenceEvent[];
  summaries: DailySummary;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertValidEmployeeId(employeeId: string): void {
  if (!ID_PATTERN.test(employeeId)) {
    throw new Error(`invalid employeeId: ${JSON.stringify(employeeId)}`);
  }
}

function utcDateOf(timestamp: string): string {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) {
    throw new Error(`invalid timestamp: ${JSON.stringify(timestamp)}`);
  }
  return time.toISOString().slice(0, 10);
}

function writeFileFsync(path: string, data: string | Buffer): void {
  const fd = openSync(path, "w");
  try {
    if (typeof data === "string") {
      writeSync(fd, data, null, "utf8");
    } else {
      writeSync(fd, data, 0, data.length, null);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Overwrite a file with random bytes, fsync, then unlink. */
function shredFile(path: string, length: number): void {
  if (!existsSync(path)) return;
  writeFileFsync(path, randomBytes(Math.max(length, 1)));
  unlinkSync(path);
}

export class EvidenceStore {
  private readonly dir: string;
  private readonly keysDir: string;
  private readonly stateDir: string;
  private readonly tombstoneDir: string;
  private readonly pendingDir: string;
  private readonly audit: AuditLog;
  private readonly keyCache = new Map<string, DataKey>();

  constructor(options: EvidenceStoreOptions) {
    this.dir = options.dir;
    this.keysDir = join(this.dir, "keys");
    this.stateDir = join(this.dir, "state");
    this.tombstoneDir = join(this.dir, "tombstones");
    this.pendingDir = join(this.dir, "pending-erase");
    for (const sub of [this.keysDir, this.stateDir, this.tombstoneDir, this.pendingDir]) {
      mkdirSync(sub, { recursive: true });
    }
    this.audit = new AuditLog(join(this.dir, "audit.log"));
    this.recoverPendingErasures();
  }

  private keyPath(id: string): string {
    return join(this.keysDir, `${id}.key`);
  }

  private statePath(id: string): string {
    return join(this.stateDir, `${id}.json`);
  }

  private tombstonePath(id: string): string {
    return join(this.tombstoneDir, id);
  }

  private pendingPath(id: string): string {
    return join(this.pendingDir, id);
  }

  private isErased(id: string): boolean {
    return existsSync(this.tombstonePath(id));
  }

  private loadKey(id: string): DataKey | null {
    const cached = this.keyCache.get(id);
    if (cached) return cached;
    const path = this.keyPath(id);
    if (!existsSync(path)) return null;
    const key = readFileSync(path);
    if (key.length !== 32) {
      throw new Error(`corrupt key file for ${id}`);
    }
    this.keyCache.set(id, key);
    return key;
  }

  private dropKey(id: string): void {
    const key = this.keyCache.get(id);
    if (key) {
      key.fill(0);
      this.keyCache.delete(id);
    }
  }

  private loadState(id: string): EmployeeState {
    const path = this.statePath(id);
    const key = this.loadKey(id);
    if (!existsSync(path) || !key) {
      return { events: [], summaries: {} };
    }
    const ciphertext = readFileSync(path, "utf8");
    return decryptJson(key, ciphertext) as EmployeeState;
  }

  private saveState(id: string, state: EmployeeState): void {
    const key = this.loadKey(id);
    if (!key) throw new Error(`no key for ${id}`);
    writeFileFsync(this.statePath(id), encryptJson(key, state));
  }

  /**
   * Finish an interrupted erasure. Every step is idempotent; safe to run
   * any number of times after a crash at any persistence boundary.
   */
  private completeErase(id: string): void {
    shredFile(this.keyPath(id), 32);
    this.dropKey(id);
    crashBoundary(2);
    const statePath = this.statePath(id);
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
    crashBoundary(3);
    if (!this.isErased(id)) {
      writeFileFsync(this.tombstonePath(id), `erased\n`);
    }
    crashBoundary(4);
    if (!this.audit.hasEraseItem(id)) {
      this.audit.append("erase", id, null);
    }
    crashBoundary(5);
    const pending = this.pendingPath(id);
    if (existsSync(pending)) {
      unlinkSync(pending);
    }
    fsyncDir(this.dir);
    crashBoundary(6);
  }

  private recoverPendingErasures(): void {
    for (const entry of readdirSync(this.pendingDir)) {
      if (ID_PATTERN.test(entry)) {
        this.completeErase(entry);
      }
    }
  }

  ingest(employeeId: string, events: EvidenceEvent[]): void {
    assertValidEmployeeId(employeeId);
    if (this.isErased(employeeId)) {
      throw new Error(`employee ${employeeId} has been permanently erased`);
    }
    for (const event of events) {
      if (typeof event.timestamp !== "string" || typeof event.eventType !== "string") {
        throw new Error("each event needs string timestamp and eventType");
      }
      utcDateOf(event.timestamp);
    }
    let key = this.loadKey(employeeId);
    if (!key) {
      key = generateDataKey();
      writeFileFsync(this.keyPath(employeeId), key);
      fsyncDir(this.keysDir);
      this.keyCache.set(employeeId, key);
    }
    const state = this.loadState(employeeId);
    for (const event of events) {
      state.events.push(event);
      const date = utcDateOf(event.timestamp);
      const byType = (state.summaries[date] ??= {});
      byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
    }
    this.saveState(employeeId, state);
    const payload: IngestAuditPayload = {
      events: events.map((event) => ({ ...event })),
      summaries: state.summaries,
    };
    this.audit.append("ingest", employeeId, encryptJson(key, payload));
  }

  readEmployee(employeeId: string): EmployeeEvidence {
    assertValidEmployeeId(employeeId);
    if (this.isErased(employeeId)) {
      return { employeeId, events: [], summaries: {} };
    }
    const state = this.loadState(employeeId);
    return { employeeId, events: state.events, summaries: state.summaries };
  }

  eraseEmployee(employeeId: string): void {
    assertValidEmployeeId(employeeId);
    if (this.isErased(employeeId) && !existsSync(this.pendingPath(employeeId))) {
      return;
    }
    if (!existsSync(this.pendingPath(employeeId))) {
      writeFileFsync(this.pendingPath(employeeId), `pending\n`);
      fsyncDir(this.pendingDir);
    }
    crashBoundary(1);
    this.completeErase(employeeId);
  }

  inspectAudit(): AuditReport {
    const verification = this.audit.verify();
    const items: AuditEntryView[] = this.audit.items().map((item) => {
      let payload: unknown = null;
      if (item.type === "ingest" && item.payloadCiphertext !== null && !this.isErased(item.employeeId)) {
        const key = this.loadKey(item.employeeId);
        if (key) {
          try {
            payload = decryptJson(key, item.payloadCiphertext);
          } catch {
            payload = null;
          }
        }
      }
      return {
        seq: item.seq,
        type: item.type,
        employeeId: item.employeeId,
        hash: item.hash,
        prevHash: item.prevHash,
        payload,
      };
    });
    return { items, integrityOk: verification.ok, integrityError: verification.error };
  }
}

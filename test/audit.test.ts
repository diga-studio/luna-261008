import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLog,
  verifyExport,
  serializeCredential,
  parseCredential,
  type ExportPackage,
  type RecordPayload,
  type SealCredential,
  type TimeWindow,
} from "../src/index.js";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  return path.join(dir, "audit.db");
}

interface RawRecord {
  timestampMs: number;
  before: string;
  after: string;
}

/** Directly filter the sealed prefix, field by field. */
function directFilter(
  records: RawRecord[],
  count: number,
  window: TimeWindow,
): RecordPayload[] {
  const result: RecordPayload[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = records[i];
    if (record.timestampMs >= window.startMs && record.timestampMs < window.endMs) {
      result.push({ seq: i + 1, ...record });
    }
  }
  return result;
}

function exportAndVerify(
  log: AuditLog,
  records: RawRecord[],
  credential: SealCredential,
  window: TimeWindow,
): RecordPayload[] {
  const pkg = log.export(window, credential);
  const verified = verifyExport(pkg, window, credential);
  assert.deepEqual(verified, directFilter(records, credential.count, window));
  return verified;
}

const SAMPLE: RawRecord[] = [
  { timestampMs: 100, before: "before-1", after: "after-1" },
  { timestampMs: 200, before: "before-2", after: "after-2" },
  { timestampMs: 200, before: "before-3", after: "after-3" },
  { timestampMs: 200, before: "before-4", after: "after-4" },
  { timestampMs: 300, before: "before-5", after: "after-5" },
  { timestampMs: 400, before: "before-6", after: "after-6" },
  { timestampMs: 500, before: "before-7", after: "after-7" },
  { timestampMs: 500, before: "before-8", after: "after-8" },
];

function sampleLog(): { log: AuditLog; credential: SealCredential; dbPath: string } {
  const dbPath = tempDbPath();
  const log = new AuditLog(dbPath);
  for (const [index, record] of SAMPLE.entries()) {
    const appended = log.append(record.timestampMs, record.before, record.after);
    assert.equal(appended.seq, index + 1);
  }
  return { log, credential: log.seal(), dbPath };
}

test("seq numbers are consecutive from 1 and timestamps must not decrease", () => {
  const { log } = sampleLog();
  assert.equal(log.count(), SAMPLE.length);
  assert.throws(() => log.append(99, "x", "y"), /before the last appended/);
  assert.doesNotThrow(() => log.append(500, "s8", "s9"));
  log.close();
});

test("identical timestamps straddling window boundaries match direct filtering", () => {
  const { log, credential } = sampleLog();
  const windows: TimeWindow[] = [
    { startMs: 100, endMs: 200 }, // only the ts=100 record
    { startMs: 200, endMs: 500 }, // the ts=200 group through ts=400
    { startMs: 200, endMs: 501 }, // everything except the first record
    { startMs: 201, endMs: 500 }, // skips the whole ts=200 group
    { startMs: 0, endMs: 1000 }, // all records
    { startMs: 300, endMs: 300 }, // empty window
  ];
  for (const window of windows) {
    exportAndVerify(log, SAMPLE, credential, window);
  }
  log.close();
});

test("windows in record-free gaps produce verifiable empty results", () => {
  const { log, credential } = sampleLog();
  const windows: TimeWindow[] = [
    { startMs: 301, endMs: 400 }, // gap between 300 and 400
    { startMs: 0, endMs: 100 }, // before the first record
    { startMs: 501, endMs: 600 }, // after the last record
  ];
  for (const window of windows) {
    const verified = exportAndVerify(log, SAMPLE, credential, window);
    assert.deepEqual(verified, []);
  }
  log.close();
});

test("export package does not leak content of records outside the window", () => {
  const { log, credential } = sampleLog();
  const pkg = log.export({ startMs: 300, endMs: 400 }, credential);
  assert.equal(pkg.hits.length, 1);
  const serialized = JSON.stringify(pkg);
  for (const record of SAMPLE) {
    if (record.timestampMs === 300) {
      continue;
    }
    assert.ok(!serialized.includes(record.before), `leaked ${record.before}`);
    assert.ok(!serialized.includes(record.after), `leaked ${record.after}`);
  }
  log.close();
});

test("verification rejects a package with an omitted hit", () => {
  const { log, credential } = sampleLog();
  const window = { startMs: 200, endMs: 500 };
  const pkg = log.export(window, credential);
  const omitted = structuredClone(pkg);
  omitted.hits.splice(1, 1); // drop a middle hit
  assert.throws(() => verifyExport(omitted, window, credential), /verification failed/);
  const omittedFirst = structuredClone(pkg);
  omittedFirst.hits.shift();
  assert.throws(() => verifyExport(omittedFirst, window, credential), /verification failed/);
  const omittedLast = structuredClone(pkg);
  omittedLast.hits.pop();
  assert.throws(() => verifyExport(omittedLast, window, credential), /verification failed/);
  log.close();
});

test("verification rejects modified record content", () => {
  const { log, credential } = sampleLog();
  const window = { startMs: 200, endMs: 500 };
  const pkg = log.export(window, credential);
  const modified = structuredClone(pkg);
  modified.hits[0].after = "forged state";
  assert.throws(() => verifyExport(modified, window, credential), /verification failed/);
  const modifiedTs = structuredClone(pkg);
  modifiedTs.hits[1].timestampMs = 201;
  assert.throws(() => verifyExport(modifiedTs, window, credential), /verification failed/);
  log.close();
});

test("verification rejects a non-empty result disguised as empty", () => {
  const { log, credential } = sampleLog();
  const window = { startMs: 200, endMs: 500 };
  const pkg = log.export(window, credential);
  assert.ok(pkg.hits.length > 0);
  const disguised: ExportPackage = { ...structuredClone(pkg), hits: [] };
  assert.throws(() => verifyExport(disguised, window, credential), /verification failed/);
  log.close();
});

test("verification rejects reordered, duplicated, or miswindowed packages", () => {
  const { log, credential } = sampleLog();
  const window = { startMs: 200, endMs: 500 };
  const pkg = log.export(window, credential);

  const reordered = structuredClone(pkg);
  [reordered.hits[0], reordered.hits[1]] = [reordered.hits[1], reordered.hits[0]];
  assert.throws(() => verifyExport(reordered, window, credential), /verification failed/);

  const duplicated = structuredClone(pkg);
  duplicated.hits.push(duplicated.hits[0]);
  assert.throws(() => verifyExport(duplicated, window, credential), /verification failed/);

  const otherWindow = { startMs: 200, endMs: 501 };
  assert.throws(() => verifyExport(pkg, otherWindow, credential), /verification failed/);

  const wrongCredential: SealCredential = { count: credential.count - 1, root: credential.root };
  assert.throws(() => verifyExport(pkg, window, wrongCredential), /verification failed/);
  log.close();
});

test("credential survives reopening; appending continues; old prefix exports still verify", () => {
  const dbPath = tempDbPath();
  const first = new AuditLog(dbPath);
  for (const record of SAMPLE.slice(0, 4)) {
    first.append(record.timestampMs, record.before, record.after);
  }
  const credential = first.seal();
  first.close();

  const reopened = new AuditLog(dbPath);
  assert.equal(reopened.count(), 4);
  // Old credential still authorizes exports of the sealed prefix.
  exportAndVerify(reopened, SAMPLE, credential, { startMs: 100, endMs: 300 });
  // Appending continues with the next sequence numbers.
  const appended = reopened.append(200, "s4", "s5");
  assert.equal(appended.seq, 5);
  reopened.append(300, "s5", "s6");
  const newCredential = reopened.seal();
  assert.equal(newCredential.count, 6);
  assert.notEqual(newCredential.root, credential.root);
  // New records are not part of the old sealed prefix, even with equal timestamps.
  const oldVerified = exportAndVerify(reopened, SAMPLE, credential, { startMs: 200, endMs: 201 });
  assert.deepEqual(oldVerified.map((r) => r.seq), [2, 3, 4]);
  const newVerified = verifyExport(
    reopened.export({ startMs: 200, endMs: 201 }, newCredential),
    { startMs: 200, endMs: 201 },
    newCredential,
  );
  assert.deepEqual(newVerified.map((r) => r.seq), [2, 3, 4, 5]);
  reopened.close();
});

test("exporting with a credential that no longer matches the database fails", () => {
  const { log, credential, dbPath } = sampleLog();
  log.close();
  // Attacker rewrites the database after the seal.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE records SET after = ? WHERE seq = ?").run("forged", 3);
  db.close();
  const reopened = new AuditLog(dbPath);
  assert.throws(
    () => reopened.export({ startMs: 200, endMs: 500 }, credential),
    /does not match the seal credential/,
  );
  reopened.close();
});

test("empty database seals and exports verifiable empty results", () => {
  const log = new AuditLog(tempDbPath());
  const credential = log.seal();
  assert.equal(credential.count, 0);
  const window = { startMs: 0, endMs: 1000 };
  const verified = verifyExport(log.export(window, credential), window, credential);
  assert.deepEqual(verified, []);
  log.close();
});

test("credential serialization round-trips", () => {
  const { log, credential } = sampleLog();
  const parsed = parseCredential(serializeCredential(credential));
  assert.deepEqual(parsed, credential);
  assert.throws(() => parseCredential('{"count":-1,"root":"00"}'));
  assert.throws(() => parseCredential('"nope"'));
  log.close();
});

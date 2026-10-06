import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { EvidenceStore } from "../src/store";
import { AuditEntry } from "../src/types";
import { check, checkThrows, cleanup, freshDir, join, listFiles, report, suite } from "./helpers";

const ERASE_STEPS = ["start", "pending", "key", "data", "tombstone", "audit", "done"];

function seedStore(dir: string): EvidenceStore {
  const store = EvidenceStore.open(dir);
  store.ingest("emp-a", [
    { timestamp: "2026-01-05T09:00:00.000Z", eventType: "login", metadata: { ip: "10.0.0.1" } },
    { timestamp: "2026-01-05T17:30:00.000Z", eventType: "logout", metadata: {} },
  ]);
  store.ingest("emp-a", [
    { timestamp: "2026-01-06T10:00:00.000Z", eventType: "login", metadata: { device: "laptop" } },
  ]);
  store.ingest("emp-b", [
    { timestamp: "2026-01-05T12:00:00.000Z", eventType: "login", metadata: { note: "keep me" } },
  ]);
  return store;
}

function auditLines(dir: string): string[] {
  return readFileSync(join(dir, "audit.log"), "utf8").split("\n").filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
suite("basic ingest / read / summaries");
{
  const dir = freshDir();
  const store = EvidenceStore.open(dir);

  const empty = store.readEmployee("emp-x");
  check(empty.events.length === 0 && Object.keys(empty.summaries).length === 0,
    "unknown employee reads empty");

  store.ingest("emp-a", [
    { timestamp: "2026-01-05T09:00:00.000Z", eventType: "login", metadata: { ip: "10.0.0.1" } },
    { timestamp: "2026-01-05T23:30:00.000Z", eventType: "login", metadata: { ip: "10.0.0.2" } },
    { timestamp: "2026-01-06T00:30:00.000Z", eventType: "export", metadata: { rows: 42 } },
  ]);
  store.ingest("emp-a", [
    { timestamp: "2026-01-06T08:00:00.000Z", eventType: "export", metadata: { rows: 7 } },
  ]);

  const rec = store.readEmployee("emp-a");
  check(rec.events.length === 4, "all 4 events returned");
  check(rec.events[0].metadata !== undefined && (rec.events[0].metadata as { ip: string }).ip === "10.0.0.1",
    "metadata preserved");
  check(rec.summaries["2026-01-05"].login === 2, "day 1 login count = 2");
  check(rec.summaries["2026-01-06"].export === 2, "day 2 export count = 2 across batches");

  const audit = store.inspectAudit();
  check(audit.intact, "audit intact after ingests");
  check(audit.entries.length === 2, "two ingest audit entries");
  const first = audit.entries[0];
  check(first.payload !== null && first.payload.events.length === 3,
    "ingest entry self-contains full batch events");
  check(first.payload !== null && first.payload.summaries["2026-01-06"].export === 1,
    "ingest entry self-contains updated summaries as of that commit");
  const second = audit.entries[1];
  check(second.payload !== null && second.payload.summaries["2026-01-06"].export === 2,
    "second entry carries cumulative summaries");

  checkThrows(() => store.ingest("emp-a", []), "empty batch rejected");
  checkThrows(
    () => store.ingest("emp-a", [{ timestamp: "not-a-date", eventType: "x", metadata: null }]),
    "invalid timestamp rejected");
  checkThrows(() => store.ingest("../escape", [
    { timestamp: "2026-01-05T09:00:00.000Z", eventType: "x", metadata: null },
  ]), "path-traversal employeeId rejected");

  // restart persistence
  const reopened = EvidenceStore.open(dir);
  check(reopened.readEmployee("emp-a").events.length === 4, "events survive restart");
  check(reopened.inspectAudit().intact, "audit intact after restart");
  cleanup(dir);
}

// ---------------------------------------------------------------------------
suite("erase: crypto-shredding, immutable audit, idempotency");
{
  const dir = freshDir();
  const store = seedStore(dir);

  const auditBefore = readFileSync(join(dir, "audit.log"));
  store.eraseEmployee("emp-a");

  const auditAfter = readFileSync(join(dir, "audit.log"));
  check(
    auditAfter.subarray(0, auditBefore.length).equals(auditBefore),
    "all previously committed audit entries byte-for-byte unchanged");
  check(auditAfter.length > auditBefore.length, "erase-complete entry appended");
  const linesAfterErase = auditLines(dir);

  store.eraseEmployee("emp-a");
  check(readFileSync(join(dir, "audit.log")).equals(auditAfter),
    "repeated erase adds no second erase-complete entry");

  const gone = store.readEmployee("emp-a");
  check(gone.events.length === 0 && Object.keys(gone.summaries).length === 0,
    "readEmployee empty after erase");
  checkThrows(
    () => store.ingest("emp-a", [
      { timestamp: "2026-01-07T00:00:00.000Z", eventType: "login", metadata: null },
    ]),
    "ingest rejected after erase");

  const other = store.readEmployee("emp-b");
  check(other.events.length === 1 && other.summaries["2026-01-05"].login === 1,
    "other employee evidence fully readable");

  const files = listFiles(dir);
  check(
    JSON.stringify(files) === JSON.stringify([
      "audit.log", "data/emp-b.enc", "keys/emp-b.key", "tombstones/emp-a",
    ]),
    `no leftover key/data/temp files for erased employee (got: ${files.join(", ")})`);

  const audit = store.inspectAudit();
  check(audit.intact, "audit chain still verifies after erase");
  check(audit.entries.filter((e) => e.type === "erase-complete" && e.employeeId === "emp-a").length === 1,
    "exactly one erase-complete entry");
  const erasedIngests = audit.entries.filter((e) => e.employeeId === "emp-a" && e.type === "ingest");
  check(erasedIngests.length === 2 && erasedIngests.every((e) => e.payloadDestroyed && e.payload === null),
    "erased employee's audit payloads undecryptable");
  const otherIngest = audit.entries.find((e) => e.employeeId === "emp-b");
  check(!!otherIngest && otherIngest.payload !== null &&
    (otherIngest.payload.events[0].metadata as { note: string }).note === "keep me",
    "other employee's audit payload still decryptable");

  // restart: tombstone + rejection persist, still one erase-complete entry
  const reopened = EvidenceStore.open(dir);
  check(reopened.readEmployee("emp-a").events.length === 0, "erase persists across restart");
  checkThrows(
    () => reopened.ingest("emp-a", [
      { timestamp: "2026-01-07T00:00:00.000Z", eventType: "login", metadata: null },
    ]),
    "ingest still rejected after restart");
  check(auditLines(dir).length === linesAfterErase.length, "restart appended nothing");
  check(reopened.inspectAudit().intact, "audit intact after restart");
  cleanup(dir);
}

// ---------------------------------------------------------------------------
suite("crash recovery: SIGKILL at every erase persistence boundary");
for (const step of ERASE_STEPS) {
  const dir = freshDir();
  const child = spawnSync(
    process.execPath,
    [join(__dirname, "crash-child.js"), dir, "emp-target", step],
    { encoding: "utf8" }
  );
  check(child.signal === "SIGKILL", `boundary "${step}": child was SIGKILLed`);

  const store = EvidenceStore.open(dir); // recovery runs here
  const eraseEntries = store.inspectAudit().entries
    .filter((e) => e.type === "erase-complete" && e.employeeId === "emp-target");

  if (step === "start") {
    // Killed before any persistent progress: original state may remain.
    check(store.readEmployee("emp-target").events.length === 3,
      "boundary \"start\": original evidence preserved");
    check(eraseEntries.length === 0, "boundary \"start\": no erase-complete entry");
  } else {
    const rec = store.readEmployee("emp-target");
    check(rec.events.length === 0 && Object.keys(rec.summaries).length === 0,
      `boundary "${step}": erase completed after restart`);
    checkThrows(
      () => store.ingest("emp-target", [
        { timestamp: "2026-01-07T00:00:00.000Z", eventType: "login", metadata: null },
      ]),
      `boundary "${step}": ingest permanently rejected`);
    check(eraseEntries.length === 1,
      `boundary "${step}": exactly one erase-complete entry`);
    check(store.inspectAudit().intact, `boundary "${step}": audit intact`);
    check(store.readEmployee("emp-other").events.length === 1,
      `boundary "${step}": other employee unaffected`);
    const files = listFiles(dir);
    check(!files.some((f) => f.includes("emp-target.key") || f.includes("emp-target.enc") || f.startsWith("erase-pending/")),
      `boundary "${step}": no key/data/pending leftovers`);
    // A second restart must not roll back or duplicate anything.
    const again = EvidenceStore.open(dir);
    check(again.inspectAudit().entries
      .filter((e) => e.type === "erase-complete" && e.employeeId === "emp-target").length === 1,
      `boundary "${step}": still one erase-complete entry after second restart`);
  }
  cleanup(dir);
}

// ---------------------------------------------------------------------------
suite("tamper detection: modify / delete committed audit entries");
{
  // modify a middle entry
  const dir1 = freshDir();
  seedStore(dir1);
  {
    const lines = auditLines(dir1);
    const entry = JSON.parse(lines[1]) as AuditEntry;
    entry.payload = "A" + (entry.payload as string).slice(1);
    lines[1] = JSON.stringify(entry);
    writeFileSync(join(dir1, "audit.log"), lines.join("\n") + "\n", "utf8");
    const audit = EvidenceStore.open(dir1).inspectAudit();
    check(!audit.intact, "modified middle entry detected");
    check(audit.problems.some((p) => p.includes("entry 2")), "problem points at entry 2");
  }
  cleanup(dir1);

  // delete a middle entry
  const dir2 = freshDir();
  seedStore(dir2);
  {
    const lines = auditLines(dir2);
    lines.splice(1, 1);
    writeFileSync(join(dir2, "audit.log"), lines.join("\n") + "\n", "utf8");
    const audit = EvidenceStore.open(dir2).inspectAudit();
    check(!audit.intact, "deleted middle entry detected");
  }
  cleanup(dir2);

  // tamper with entries left behind by an erased employee
  const dir3 = freshDir();
  {
    const store = seedStore(dir3);
    store.eraseEmployee("emp-a");
    const lines = auditLines(dir3);
    const entry = JSON.parse(lines[0]) as AuditEntry; // emp-a ingest entry
    entry.payload = "B" + (entry.payload as string).slice(1);
    lines[0] = JSON.stringify(entry);
    writeFileSync(join(dir3, "audit.log"), lines.join("\n") + "\n", "utf8");
    check(!EvidenceStore.open(dir3).inspectAudit().intact,
      "modified entry of erased employee detected");
  }
  cleanup(dir3);

  // delete an entry left behind by an erased employee
  const dir4 = freshDir();
  {
    const store = seedStore(dir4);
    store.eraseEmployee("emp-a");
    const lines = auditLines(dir4);
    lines.splice(0, 1); // drop emp-a's first ingest entry
    writeFileSync(join(dir4, "audit.log"), lines.join("\n") + "\n", "utf8");
    check(!EvidenceStore.open(dir4).inspectAudit().intact,
      "deleted entry of erased employee detected");
  }
  cleanup(dir4);
}

report();

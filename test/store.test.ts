import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EvidenceStore } from "../src/index.js";
import type { EvidenceEvent } from "../src/index.js";
import { dirContainsPlaintext, freshDir, listFiles, makeEvent, marker } from "./helpers.js";

const ALICE = "emp-a1b2c3";
const BOB = "emp-d4e5f6";

function aliceBatch1(note: string): EvidenceEvent[] {
  return [
    makeEvent("2026-01-05T09:00:00Z", "login", note),
    makeEvent("2026-01-05T10:00:00Z", "login", note),
    makeEvent("2026-01-06T11:00:00Z", "export", note),
  ];
}

test("ingest and readEmployee returns events and daily summaries", () => {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  store.ingest(ALICE, aliceBatch1("first"));
  store.ingest(ALICE, [makeEvent("2026-01-06T12:00:00Z", "export", "second")]);

  const evidence = store.readEmployee(ALICE);
  assert.equal(evidence.events.length, 4);
  assert.deepEqual(evidence.summaries, {
    "2026-01-05": { login: 2 },
    "2026-01-06": { export: 2 },
  });
});

test("data survives restart (new store on same dir)", () => {
  const dir = freshDir();
  new EvidenceStore({ dir }).ingest(ALICE, aliceBatch1("persist"));
  const reopened = new EvidenceStore({ dir });
  const evidence = reopened.readEmployee(ALICE);
  assert.equal(evidence.events.length, 3);
  assert.deepEqual(evidence.summaries["2026-01-05"], { login: 2 });
});

test("ingest audit items are self-contained and integrity holds", () => {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  const batch = aliceBatch1("audit");
  store.ingest(ALICE, batch);
  store.ingest(ALICE, [makeEvent("2026-01-07T08:00:00Z", "login", "later")]);

  const report = store.inspectAudit();
  assert.equal(report.integrityOk, true, report.integrityError ?? "");
  assert.equal(report.items.length, 2);

  const first = report.items[0]!.payload as { events: EvidenceEvent[]; summaries: unknown };
  assert.equal(first.events.length, 3);
  assert.deepEqual(
    first.events.map((e) => e.eventType),
    ["login", "login", "export"],
  );
  assert.deepEqual(first.summaries, {
    "2026-01-05": { login: 2 },
    "2026-01-06": { export: 1 },
  });

  const second = report.items[1]!.payload as { events: EvidenceEvent[]; summaries: unknown };
  assert.equal(second.events.length, 1);
  assert.deepEqual(second.summaries, {
    "2026-01-05": { login: 2 },
    "2026-01-06": { export: 1 },
    "2026-01-07": { login: 1 },
  });
});

test("erase: empty read, ingest rejected, single erase audit item, others unaffected", () => {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  const aliceNote = marker();
  const bobNote = marker();
  store.ingest(ALICE, aliceBatch1(aliceNote));
  store.ingest(BOB, [makeEvent("2026-02-01T00:00:00Z", "login", bobNote)]);
  store.ingest(ALICE, [makeEvent("2026-01-08T00:00:00Z", "login", aliceNote)]);

  const auditBefore = readFileSync(join(dir, "audit.log"));

  store.eraseEmployee(ALICE);
  store.eraseEmployee(ALICE);

  assert.deepEqual(store.readEmployee(ALICE), { employeeId: ALICE, events: [], summaries: {} });
  assert.throws(() => store.ingest(ALICE, aliceBatch1("x")), /permanently erased/);

  const bob = store.readEmployee(BOB);
  assert.equal(bob.events.length, 1);
  assert.deepEqual(bob.summaries, { "2026-02-01": { login: 1 } });

  const report = store.inspectAudit();
  assert.equal(report.integrityOk, true, report.integrityError ?? "");
  assert.equal(report.items.length, 4);
  assert.equal(report.items.filter((i) => i.type === "erase").length, 1);
  assert.equal(report.items[3]!.type, "erase");
  assert.equal(report.items[3]!.employeeId, ALICE);

  // Previously committed audit items unchanged, byte for byte.
  const auditAfter = readFileSync(join(dir, "audit.log"));
  assert.ok(auditAfter.subarray(0, auditBefore.length).equals(auditBefore));

  // Erased employee's historical payloads no longer decryptable; Bob's still readable.
  assert.equal(report.items[0]!.payload, null);
  assert.equal(report.items[2]!.payload, null);
  const bobItem = report.items[1]!.payload as { events: EvidenceEvent[] };
  assert.equal(bobItem.events.length, 1);

  // No recoverable plaintext of Alice anywhere in the persistence dir; Bob's intact.
  assert.equal(dirContainsPlaintext(dir, aliceNote), false);
  assert.equal(dirContainsPlaintext(dir, bobNote), false, "Bob's data must be encrypted at rest too");
  assert.ok(!listFiles(dir).some((f) => f.includes(ALICE) && f.startsWith("keys/")));
  assert.ok(!listFiles(dir).some((f) => f.startsWith("pending-erase/")));
});

test("erasure persists across restart; ban and unreadability hold", () => {
  const dir = freshDir();
  const aliceNote = marker();
  const store = new EvidenceStore({ dir });
  store.ingest(ALICE, aliceBatch1(aliceNote));
  store.ingest(BOB, [makeEvent("2026-02-01T00:00:00Z", "login", "bob")]);
  store.eraseEmployee(ALICE);

  const reopened = new EvidenceStore({ dir });
  assert.deepEqual(reopened.readEmployee(ALICE), { employeeId: ALICE, events: [], summaries: {} });
  assert.throws(() => reopened.ingest(ALICE, aliceBatch1("x")), /permanently erased/);
  assert.equal(reopened.readEmployee(BOB).events.length, 1);
  const report = reopened.inspectAudit();
  assert.equal(report.integrityOk, true, report.integrityError ?? "");
  assert.equal(report.items.filter((i) => i.type === "erase").length, 1);
  assert.equal(dirContainsPlaintext(dir, aliceNote), false);
});

test("readEmployee of unknown employee is empty; erase is idempotent for unknown id", () => {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  assert.deepEqual(store.readEmployee("emp-unknown"), {
    employeeId: "emp-unknown",
    events: [],
    summaries: {},
  });
  store.eraseEmployee("emp-unknown");
  store.eraseEmployee("emp-unknown");
  const report = store.inspectAudit();
  assert.equal(report.items.filter((i) => i.type === "erase").length, 1);
  assert.equal(report.integrityOk, true);
});

test("invalid employeeId and invalid timestamp are rejected", () => {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  assert.throws(() => store.ingest("../evil", aliceBatch1("x")), /invalid employeeId/);
  assert.throws(() => store.ingest(ALICE, [makeEvent("not-a-date", "login", "x")]), /invalid timestamp/);
});

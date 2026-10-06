import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLedger } from "../src/index.js";
import {
  assertArchiveDirClean,
  assertMatchesOriginal,
  makeTempDir,
  readAll,
} from "./helpers.js";

const T0 = 1_700_000_000_000; // fixed base time (ms since epoch)

test("out-of-order times, late records, exact-cutoff records, multiple archives", () => {
  const dir = makeTempDir("ledger-archive-");
  const original = new Map<number, { eventTimeMs: number; body: string }>();
  const ledger = AuditLedger.open({ dir });

  // Append records with shuffled event times; some exactly at the cutoffs.
  const cutoff1 = T0 + 1_000;
  const cutoff2 = T0 + 2_000;
  const times = [
    cutoff1 + 500, // stays online after archive 1
    cutoff1 - 1,   // archived by archive 1
    cutoff1,       // exactly at cutoff: stays online
    cutoff1 - 500, // archived by archive 1
    cutoff2 + 9_999, // stays online throughout
    cutoff2,       // exactly at cutoff2: survives archive 2
    cutoff1 - 999, // archived by archive 1
  ];
  for (const [i, t] of times.entries()) {
    const id = ledger.append(t, JSON.stringify({ seq: i, t }));
    original.set(id, { eventTimeMs: t, body: JSON.stringify({ seq: i, t }) });
  }

  // First archive: only strictly-older-than-cutoff1 bodies leave SQLite.
  assert.equal(ledger.archive(cutoff1), 3);
  const onlineAfter1 = ledger.onlineIds();
  const wantOnline1 = [...original.keys()].filter(
    (id) => original.get(id)!.eventTimeMs >= cutoff1,
  );
  assert.deepEqual(onlineAfter1, wantOnline1);
  assertMatchesOriginal(readAll(ledger), original);

  // Late records arriving after the first archive: some old enough to be
  // archived next time, one exactly at cutoff2, some newer.
  const lateTimes = [cutoff1 - 100_000, cutoff2 - 1, cutoff2, cutoff2 + 1];
  for (const [i, t] of lateTimes.entries()) {
    const id = ledger.append(t, JSON.stringify({ late: i, t }));
    original.set(id, { eventTimeMs: t, body: JSON.stringify({ late: i, t }) });
  }

  // Second archive: migrates everything strictly before cutoff2,
  // including the late arrivals missed by the first archive.
  const archived2 = ledger.archive(cutoff2);
  const wantArchived2 = [...original.values()].filter(
    (r) => r.eventTimeMs < cutoff2,
  ).length;
  assert.equal(archived2, wantArchived2 - 3);
  const wantOnline2 = [...original.keys()].filter(
    (id) => original.get(id)!.eventTimeMs >= cutoff2,
  );
  assert.deepEqual(ledger.onlineIds(), wantOnline2);

  // Continuous paging over the mixed online+archived ledger matches the
  // original ledger exactly.
  assertMatchesOriginal(readAll(ledger, 3), original);
  assert.equal(ledger.size(), original.size);
  assertArchiveDirClean(dir, 2);

  // Reopen and verify persistence.
  ledger.close();
  const reopened = AuditLedger.open({ dir });
  assertMatchesOriginal(readAll(reopened, 4), original);
  assert.deepEqual(reopened.onlineIds(), wantOnline2);
  reopened.close();
});

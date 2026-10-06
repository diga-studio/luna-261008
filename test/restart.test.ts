import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLedger } from "../src/index.js";
import {
  assertArchiveDirClean,
  assertMatchesOriginal,
  makeTempDir,
  readAll,
} from "./helpers.js";

const T0 = 1_800_000_000_000;

test("archive everything, restart, append more, archive again", () => {
  const dir = makeTempDir("ledger-restart-");
  const original = new Map<number, { eventTimeMs: number; body: string }>();
  const keep = (id: number, eventTimeMs: number, body: string): void => {
    original.set(id, { eventTimeMs, body });
  };

  // Phase 1: append and archive every online record.
  let ledger = AuditLedger.open({ dir });
  let lastId = 0;
  for (let i = 0; i < 30; i++) {
    const t = T0 + i * 1_000;
    const body = JSON.stringify({ phase: 1, i });
    lastId = ledger.append(t, body);
    keep(lastId, t, body);
  }
  assert.equal(ledger.archive(Number.MAX_SAFE_INTEGER), 30);
  assert.deepEqual(ledger.onlineIds(), [], "SQLite must hold no bodies");
  assertMatchesOriginal(readAll(ledger, 4), original);
  ledger.close();

  // Phase 2: reopen with an empty online table; ids must keep increasing.
  ledger = AuditLedger.open({ dir });
  assertMatchesOriginal(readAll(ledger, 4), original);
  const firstNewId = ledger.append(T0 + 100_000, JSON.stringify({ phase: 2 }));
  assert.ok(firstNewId > lastId, `id ${firstNewId} not > ${lastId}`);
  keep(firstNewId, T0 + 100_000, JSON.stringify({ phase: 2 }));
  for (let i = 1; i < 10; i++) {
    const t = T0 + 100_000 + i;
    const body = JSON.stringify({ phase: 2, i });
    lastId = ledger.append(t, body);
    keep(lastId, t, body);
  }
  ledger.close();

  // Phase 3: reopen, archive the new records too, then read old+new
  // together with no duplicates and no omissions.
  ledger = AuditLedger.open({ dir });
  assert.equal(ledger.archive(Number.MAX_SAFE_INTEGER), 10);
  assert.deepEqual(ledger.onlineIds(), []);
  assertMatchesOriginal(readAll(ledger, 6), original);
  assert.equal(ledger.size(), original.size);
  assertArchiveDirClean(dir, 2);
  ledger.close();

  // Phase 4: after another restart the merged ledger is still complete,
  // and appends still get fresh ids.
  ledger = AuditLedger.open({ dir });
  assertMatchesOriginal(readAll(ledger, 6), original);
  const id = ledger.append(T0 + 200_000, "{}");
  assert.ok(id > lastId);
  ledger.close();
});

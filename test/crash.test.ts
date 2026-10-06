import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { freshDir, marker } from "./helpers.js";

const VICTIM = "emp-victim01";
const OTHER = "emp-other02";

const eraseChildPath = join(import.meta.dirname, "child", "eraseChild.js");
const verifyChildPath = join(import.meta.dirname, "child", "verifyChild.js");

interface VerifyResult {
  victimRead: { events: unknown[]; summaries: Record<string, unknown> };
  ingestRejected: boolean;
  eraseItemCount: number;
  integrityOk: boolean;
  integrityError: string | null;
  victimPayloads: unknown[];
  otherEventCount: number;
  otherSummaries: Record<string, Record<string, number>>;
  files: string[];
  victimPlaintextFound: boolean;
  otherPlaintextFound: boolean;
}

function runEraseChild(dir: string, victimNote: string, otherNote: string, crashAfterStep: number) {
  return spawnSync(process.execPath, [eraseChildPath, dir, VICTIM, OTHER, victimNote, otherNote], {
    env: { ...process.env, EES_CRASH_AFTER_STEP: String(crashAfterStep) },
    encoding: "utf8",
  });
}

function runVerifyChild(dir: string, victimNote: string, otherNote: string): VerifyResult {
  const out = execFileSync(process.execPath, [verifyChildPath, dir, VICTIM, OTHER, victimNote, otherNote], {
    encoding: "utf8",
  });
  const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
  assert.ok(line, `verify child produced no result: ${out}`);
  return JSON.parse(line.slice("RESULT:".length)) as VerifyResult;
}

function assertFullyErased(result: VerifyResult): void {
  assert.deepEqual(result.victimRead, { employeeId: VICTIM, events: [], summaries: {} });
  assert.equal(result.ingestRejected, true, "ingest after erase must be rejected");
  assert.equal(result.eraseItemCount, 1, "exactly one erase-complete audit item");
  assert.equal(result.integrityOk, true, result.integrityError ?? "");
  assert.ok(result.victimPayloads.every((p) => p === null), "victim audit payloads unreadable");
  assert.equal(result.otherEventCount, 1);
  assert.deepEqual(result.otherSummaries, { "2026-02-01": { login: 1 } });
  assert.ok(!result.files.some((f) => f === `keys/${VICTIM}.key`), "victim key file must be gone");
  assert.ok(!result.files.some((f) => f.startsWith("pending-erase/")), "no pending markers left");
  assert.equal(result.victimPlaintextFound, false, "no recoverable victim plaintext on disk");
  assert.equal(result.otherPlaintextFound, false, "other employee stored encrypted");
}

// Persistence boundaries inside eraseEmployee:
// 1 = pending marker written, 2 = key shredded, 3 = state file removed,
// 4 = tombstone written, 5 = erase audit item appended, 6 = pending marker removed.
for (let step = 1; step <= 6; step += 1) {
  test(`crash after erase persistence boundary ${step}: restart completes erasure`, () => {
    const dir = freshDir();
    const victimNote = marker();
    const otherNote = marker();

    const crashed = runEraseChild(dir, victimNote, otherNote, step);
    assert.equal(crashed.signal, "SIGKILL", `expected SIGKILL, got: ${crashed.stdout} ${crashed.stderr}`);

    const result = runVerifyChild(dir, victimNote, otherNote);
    assertFullyErased(result);
  });
}

test("no crash: erase completes normally in one process", () => {
  const dir = freshDir();
  const victimNote = marker();
  const otherNote = marker();

  const done = runEraseChild(dir, victimNote, otherNote, 0);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /ERASE_COMPLETED_NORMALLY/);

  const result = runVerifyChild(dir, victimNote, otherNote);
  assertFullyErased(result);
});

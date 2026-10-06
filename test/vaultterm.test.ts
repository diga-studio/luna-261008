import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { open, VaultTermError } from "../src/index";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vaultterm-test-"));
}

function freshKey(): Uint8Array {
  return randomBytes(32);
}

function logPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.log`);
}

test("append returns contiguous 1-based sequence numbers", () => {
  const dir = freshDir();
  const s = open(dir, freshKey(), "sess-seq");
  assert.equal(s.append("e1", new Uint8Array([1, 2, 3])), 1);
  assert.equal(s.append("e2", new Uint8Array([4, 5])), 2);
  assert.equal(s.append("e3", new Uint8Array([6])), 3);
});

test("retry with same eventId and bytes returns original seq; different bytes conflict", () => {
  const dir = freshDir();
  const s = open(dir, freshKey(), "sess-dedup");
  const bytes = new Uint8Array([9, 8, 7]);
  assert.equal(s.append("evt", bytes), 1);
  assert.equal(s.append("evt", bytes), 1);
  assert.throws(
    () => s.append("evt", new Uint8Array([9, 8, 8])),
    (e: unknown) => e instanceof VaultTermError && e.code === "EVENT_CONFLICT"
  );
});

test("recovery preserves dedup history across reopen", () => {
  const dir = freshDir();
  const key = freshKey();
  const s1 = open(dir, key, "sess-recover");
  assert.equal(s1.append("a", new Uint8Array([1])), 1);
  assert.equal(s1.append("b", new Uint8Array([2])), 2);

  const s2 = open(dir, key, "sess-recover");
  assert.equal(s2.append("a", new Uint8Array([1])), 1);
  assert.throws(
    () => s2.append("b", new Uint8Array([3])),
    (e: unknown) => e instanceof VaultTermError && e.code === "EVENT_CONFLICT"
  );
  assert.equal(s2.append("c", new Uint8Array([3])), 3);
});

test("read returns decrypted records in order", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-read");
  s.append("x", new Uint8Array([0x1b, 0x5b, 0x41]));
  s.append("y", new Uint8Array([0x0d]));
  const records = s.read();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.seq, r.eventId, Array.from(r.bytes)]),
    [
      [1, "x", [0x1b, 0x5b, 0x41]],
      [2, "y", [0x0d]],
    ]
  );
});

test("seal persists across reopen: repeat seal and retries ok, new events rejected", () => {
  const dir = freshDir();
  const key = freshKey();
  const s1 = open(dir, key, "sess-seal");
  assert.equal(s1.append("kept", new Uint8Array([1, 1])), 1);
  s1.seal();
  s1.seal(); // idempotent

  const s2 = open(dir, key, "sess-seal");
  assert.equal(s2.sealed, true);
  s2.seal(); // repeated seal after reopen is a no-op
  assert.equal(s2.append("kept", new Uint8Array([1, 1])), 1); // existing retry still accepted
  assert.throws(
    () => s2.append("kept", new Uint8Array([2, 2])),
    (e: unknown) => e instanceof VaultTermError && e.code === "EVENT_CONFLICT"
  );
  assert.throws(
    () => s2.append("brand-new", new Uint8Array([3])),
    (e: unknown) => e instanceof VaultTermError && e.code === "SESSION_SEALED"
  );

  const s3 = open(dir, key, "sess-seal");
  assert.equal(s3.sealed, true);
  assert.throws(
    () => s3.append("another", new Uint8Array([4])),
    (e: unknown) => e instanceof VaultTermError && e.code === "SESSION_SEALED"
  );
  const records = s3.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.eventId, "kept");
});

test("seal is irrevocable: metadata flag cannot be rolled back", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-irrevocable");
  s.append("e", new Uint8Array([1]));
  s.seal();
  const reopened = open(dir, key, "sess-irrevocable");
  assert.equal(reopened.sealed, true);
  assert.throws(
    () => reopened.append("late", new Uint8Array([2])),
    (e: unknown) => e instanceof VaultTermError && e.code === "SESSION_SEALED"
  );
});

test("tampering with a middle ciphertext is detected on reopen", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-tamper-mid");
  s.append("e1", new Uint8Array([1]));
  s.append("e2", new Uint8Array([2]));
  s.append("e3", new Uint8Array([3]));
  s.seal();

  const path = logPath(dir, "sess-tamper-mid");
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const middle = JSON.parse(lines[1]!) as { ct: string };
  // Flip one byte inside the middle ciphertext.
  const ct = Buffer.from(middle.ct, "hex");
  ct[0] = (ct[0]! ^ 0xff) & 0xff;
  middle.ct = ct.toString("hex");
  lines[1] = JSON.stringify(middle);
  writeFileSync(path, lines.join("\n") + "\n");

  assert.throws(
    () => open(dir, key, "sess-tamper-mid"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("truncating the tail of a sealed log is detected on reopen", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-tamper-tail");
  s.append("e1", new Uint8Array([1]));
  s.append("e2", new Uint8Array([2]));
  s.seal();

  const path = logPath(dir, "sess-tamper-tail");
  const body = readFileSync(path, "utf8");
  const lines = body.split("\n").filter((l) => l.length > 0);
  // Drop the final (seal) record.
  writeFileSync(path, lines.slice(0, -1).join("\n") + "\n");

  assert.throws(
    () => open(dir, key, "sess-tamper-tail"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("deleting a middle record is detected", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-delete");
  s.append("e1", new Uint8Array([1]));
  s.append("e2", new Uint8Array([2]));
  s.append("e3", new Uint8Array([3]));

  const path = logPath(dir, "sess-delete");
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  lines.splice(1, 1);
  writeFileSync(path, lines.join("\n") + "\n");

  assert.throws(
    () => open(dir, key, "sess-delete"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("reordering records is detected", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-reorder");
  s.append("e1", new Uint8Array([1]));
  s.append("e2", new Uint8Array([2]));
  s.append("e3", new Uint8Array([3]));

  const path = logPath(dir, "sess-reorder");
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  writeFileSync(path, lines.join("\n") + "\n");

  assert.throws(
    () => open(dir, key, "sess-reorder"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("cross-session log replacement is detected", () => {
  const dir = freshDir();
  const key = freshKey();
  const a = open(dir, key, "sess-alpha");
  a.append("e1", new Uint8Array([1]));
  const b = open(dir, key, "sess-beta");
  b.append("e1", new Uint8Array([9]));

  // Attacker replaces alpha's log with beta's log (metadata untouched).
  writeFileSync(logPath(dir, "sess-alpha"), readFileSync(logPath(dir, "sess-beta")));

  assert.throws(
    () => open(dir, key, "sess-alpha"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("wrong key is rejected on recovery and read", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-key");
  s.append("e1", new Uint8Array([1]));

  assert.throws(
    () => open(dir, freshKey(), "sess-key"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
  assert.throws(
    () => open(dir, freshKey(), "sess-key").read(),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("key must be 32 bytes", () => {
  const dir = freshDir();
  assert.throws(
    () => open(dir, new Uint8Array(16), "sess-badkey"),
    (e: unknown) => e instanceof VaultTermError && e.code === "INVALID_KEY"
  );
});

test("log is an append-only local file and ciphertext does not leak plaintext", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-file");
  const secret = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  s.append("e1", secret);
  s.seal();

  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["sess-file.log", "sess-file.meta.json"]);
  const body = readFileSync(logPath(dir, "sess-file"), "utf8");
  assert.ok(!body.includes("deadbeef"), "log must not contain plaintext hex");
  assert.ok(!body.includes("3q2+7w"), "log must not contain plaintext base64");
});

test("nonces never repeat within a session", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-nonce");
  for (let i = 0; i < 50; i += 1) {
    s.append(`e${i}`, new Uint8Array([i]));
  }
  s.seal();

  const lines = readFileSync(logPath(dir, "sess-nonce"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const nonces = lines.map((l) => (JSON.parse(l) as { nonce: string }).nonce);
  assert.equal(new Set(nonces).size, nonces.length);
});

test("read() re-verifies: tampering after open is detected on read", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-readverify");
  s.append("e1", new Uint8Array([1]));
  s.append("e2", new Uint8Array([2]));

  const path = logPath(dir, "sess-readverify");
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const first = JSON.parse(lines[0]!) as { ct: string };
  const ct = Buffer.from(first.ct, "hex");
  ct[0] = (ct[0]! ^ 0x01) & 0xff;
  first.ct = ct.toString("hex");
  lines[0] = JSON.stringify(first);
  writeFileSync(path, lines.join("\n") + "\n");

  assert.throws(
    () => s.read(),
    (e: unknown) => e instanceof VaultTermError && e.code === "INTEGRITY_FAILURE"
  );
});

test("eventIds that look like object internals are plain data", () => {
  const dir = freshDir();
  const key = freshKey();
  const s = open(dir, key, "sess-proto");
  assert.equal(s.append("__proto__", new Uint8Array([1])), 1);
  assert.equal(s.append("constructor", new Uint8Array([2])), 2);
  assert.equal(s.append("__proto__", new Uint8Array([1])), 1);
  assert.throws(
    () => s.append("__proto__", new Uint8Array([9])),
    (e: unknown) => e instanceof VaultTermError && e.code === "EVENT_CONFLICT"
  );

  const reopened = open(dir, key, "sess-proto");
  assert.equal(reopened.append("__proto__", new Uint8Array([1])), 1);
  assert.equal(reopened.read().length, 2);
});

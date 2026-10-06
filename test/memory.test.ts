import { test } from "node:test";
import assert from "node:assert/strict";
import { DestructiveSqlAnalyzer } from "../src/index.js";

const CHUNK = 64 * 1024;
const MIB = 1024 * 1024;

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/** Stream `bytes` bytes of filler between prefix and suffix, in 64 KiB chunks. */
function stream(prefix: string, fillerByte: number, bytes: number, suffix: string) {
  const a = new DestructiveSqlAnalyzer();
  const enc = new TextEncoder();
  a.push(enc.encode(prefix));
  const buf = new Uint8Array(CHUNK).fill(fillerByte);
  let remaining = bytes;
  while (remaining > 0) {
    const n = Math.min(CHUNK, remaining);
    a.push(buf.subarray(0, n));
    remaining -= n;
  }
  a.push(enc.encode(suffix));
  return a.end();
}

test("128 MiB string body: hits stay correct and extra memory stays under 16 MiB", () => {
  gc();
  const before = heapUsed();
  const prefix = `DROP TABLE mem_first; SELECT '`;
  const suffix = `'; TRUNCATE mem_last;`;
  const r = stream(prefix, 0x78, 128 * MIB, suffix);
  gc();
  const after = heapUsed();
  const truncAt =
    prefix.length + 128 * MIB + suffix.indexOf("TRUNCATE");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropTable", table: ["mem_first"], offset: 0 },
    { operation: "truncate", table: ["mem_last"], offset: truncAt },
  ]);
  const extra = after - before;
  assert.ok(
    extra < 16 * MIB,
    `extra heap ${(extra / MIB).toFixed(1)} MiB exceeds 16 MiB budget`,
  );
});

test("64 MiB nested block comment without hits stays within budget", () => {
  gc();
  const before = heapUsed();
  const r = stream(`SELECT 1 /* outer /* inner */ `, 0x2d, 64 * MIB, ` still comment */;`);
  gc();
  const after = heapUsed();
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, []);
  const extra = after - before;
  assert.ok(
    extra < 16 * MIB,
    `extra heap ${(extra / MIB).toFixed(1)} MiB exceeds 16 MiB budget`,
  );
});

test("truncated tail after a long body reports incomplete", () => {
  const r = stream(`TRUNCATE kept; SELECT '`, 0x61, 8 * MIB, ``);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.hits, [
    { operation: "truncate", table: ["kept"], offset: 0 },
  ]);
});

test("hits of the unfinished trailing statement are dropped", () => {
  const r = stream(`DROP TABLE a, b /* `, 0x20, 4 * MIB, ``);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.hits, []);
});

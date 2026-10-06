import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestructiveScanner } from '../src/index.ts';

const CHUNK = 64 * 1024;

function feedBytes(scanner: DestructiveScanner, bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += CHUNK) {
    scanner.push(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
}

function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

test('128 MiB 长字符串与长注释无命中，额外内存低于 16 MiB', () => {
  const MiB = 1024 * 1024;
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  parts.push(enc.encode('SELECT \''));
  const filler = new Uint8Array(96 * MiB).fill(0x61); // 96 MiB 字符串内容
  parts.push(filler);
  parts.push(enc.encode('\'; /*'));
  const comment = new Uint8Array(31 * MiB).fill(0x62); // 31 MiB 块注释内容
  parts.push(comment);
  parts.push(enc.encode('*/ SELECT 1;'));
  const total = parts.reduce((n, p) => n + p.length, 0);
  assert.ok(total >= 127 * MiB, `total=${total}`);

  const before = heapUsed();
  const scanner = new DestructiveScanner();
  for (const p of parts) feedBytes(scanner, p);
  const result = scanner.finish();
  const after = heapUsed();

  assert.equal(result.complete, true);
  assert.deepEqual(result.hits, []);
  const extra = after - before;
  assert.ok(extra < 16 * MiB, `额外堆内存 ${(extra / MiB).toFixed(2)} MiB 超限`);
});

test('长输入中夹带真实命中', () => {
  const MiB = 1024 * 1024;
  const enc = new TextEncoder();
  const scanner = new DestructiveScanner();
  const prefix = enc.encode('INSERT INTO t VALUES (\'');
  feedBytes(scanner, prefix);
  feedBytes(scanner, new Uint8Array(64 * MiB).fill(0x78));
  const suffix = enc.encode('\'); DROP TABLE victim;');
  feedBytes(scanner, suffix);
  const result = scanner.finish();
  assert.equal(result.complete, true);
  assert.deepEqual(result.hits.map((h) => h.table), ['victim']);
  const dropInSuffix = new TextDecoder().decode(suffix).indexOf('DROP');
  assert.equal(result.hits[0].offset, prefix.length + 64 * MiB + dropInSuffix);
});

test('超长未闭合字符串：无法完整判定', () => {
  const MiB = 1024 * 1024;
  const enc = new TextEncoder();
  const scanner = new DestructiveScanner();
  feedBytes(scanner, enc.encode('DROP TABLE kept; SELECT \''));
  feedBytes(scanner, new Uint8Array(32 * MiB).fill(0x78));
  const result = scanner.finish();
  assert.equal(result.complete, false);
  assert.deepEqual(result.hits.map((h) => h.table), ['kept']);
});

test('超长未闭合块注释：无法完整判定且无新命中', () => {
  const MiB = 1024 * 1024;
  const enc = new TextEncoder();
  const scanner = new DestructiveScanner();
  feedBytes(scanner, enc.encode('TRUNCATE kept /*'));
  feedBytes(scanner, new Uint8Array(32 * MiB).fill(0x78));
  const result = scanner.finish();
  assert.equal(result.complete, false);
  assert.deepEqual(result.hits, []);
});

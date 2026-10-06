import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compile, translate } from "../src/index";
import type { Entry } from "../src/index";
import { fixedChunks, naiveTranslate, runTranslate, wholeChunk } from "./helpers";

const MIB = 1 << 20;

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const out: Uint8Array[] = [];
  for await (const piece of chunks) out.push(piece);
  const total = out.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of out) {
    joined.set(p, off);
    off += p.length;
  }
  return new TextDecoder().decode(joined);
}

test("stress: one 8192-code-point source vs 1MiB of 'a'", { timeout: 120000 }, async (t) => {
  // The source is 8191 x 'a' + 'b'; the input never contains 'b', so every
  // position starts a prefix of the source that dies 8191 code points later.
  // Failure links keep each input code point at amortized O(1) work instead
  // of re-probing the 8191-long prefix per position.
  const entries: Entry[] = [{ source: "a".repeat(8191) + "b", target: "<HIT>" }];
  const input = "a".repeat(MIB);

  const t0 = performance.now();
  const table = compile(entries);
  const t1 = performance.now();
  const output = await collect(translate(table, fixedChunks(input)));
  const t2 = performance.now();

  t.diagnostic(`compile: ${(t1 - t0).toFixed(1)}ms, translate ${MIB} code points: ${(t2 - t1).toFixed(1)}ms`);
  assert.equal(output, input);
});

test("stress: sources 'a'..'a'^1999 vs 1MiB of 'a'", { timeout: 120000 }, async (t) => {
  // Every position ends 1999 candidate matches. Only the longest is kept via
  // the terminal node on the walk, so per-position work stays O(1) amortized
  // instead of enumerating all 1999 hits.
  const entries: Entry[] = [];
  for (let k = 1; k <= 1999; k++) {
    entries.push({ source: "a".repeat(k), target: `<${k}>` });
  }
  const input = "a".repeat(MIB);

  const t0 = performance.now();
  const table = compile(entries);
  const t1 = performance.now();
  const output = await collect(translate(table, fixedChunks(input)));
  const t2 = performance.now();

  t.diagnostic(`compile: ${(t1 - t0).toFixed(1)}ms, translate ${MIB} code points: ${(t2 - t1).toFixed(1)}ms`);

  // Greedy longest match consumes 1999 code points per step.
  let expected = "";
  let remaining = input.length;
  while (remaining > 0) {
    const take = Math.min(1999, remaining);
    expected += `<${take}>`;
    remaining -= take;
  }
  assert.equal(output, expected);
});

test("paused source: determined output is emitted without more input", { timeout: 30000 }, async (t) => {
  const entries: Entry[] = [
    { source: "ab", target: "<AB>" },
    { source: "abcd", target: "<ABCD>" },
  ];
  // L = 4, so the uncommitted-input bound is 4*L + 4096 = 4112 code points.
  const L = 4;
  const prefix = "x".repeat(4 * L + 4096 + 10000); // exceeds the bound
  const rest = "yyabcdzzab";
  const encoder = new TextEncoder();

  let notifyOutput: () => void = () => {};
  const outputSeen = new Promise<void>((resolve) => {
    notifyOutput = resolve;
  });

  async function* pausingSource(): AsyncIterable<Uint8Array> {
    // Feed the prefix in 4096-byte chunks, then stall until the consumer
    // observes output; only then provide the rest.
    const bytes = encoder.encode(prefix);
    for (let i = 0; i < bytes.length; i += 4096) {
      yield bytes.subarray(i, i + 4096);
    }
    await outputSeen;
    yield encoder.encode(rest);
  }

  const table = compile(entries);
  const t0 = performance.now();
  let output = "";
  const dec = new TextDecoder();
  for await (const piece of translate(table, pausingSource())) {
    output += dec.decode(piece, { stream: true });
    notifyOutput();
  }
  output += dec.decode();
  const t1 = performance.now();
  t.diagnostic(`paused-source translate: ${(t1 - t0).toFixed(1)}ms`);

  // The translation advanced past the stall and the final result equals the
  // whole-text result.
  const expected = naiveTranslate(entries, prefix + rest);
  assert.equal(output, expected);
  assert.equal(output, await runTranslate(entries, wholeChunk(prefix + rest)));
});

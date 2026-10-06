import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compile, translate } from "../src/index.ts";
import type { PhraseEntry } from "../src/index.ts";
import {
  chunkBytes,
  concatBytes,
  encode,
  makeRandom,
  randomChunks,
  referenceTranslate,
  runTranslate,
} from "./helpers.ts";

const MIB = 1024 * 1024;

async function* toStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function translateText(
  table: ReturnType<typeof compile>,
  text: string,
  chunkSize: number,
): Promise<string> {
  const chunks = chunkBytes(encode(text), [chunkSize]);
  const parts: Uint8Array[] = [];
  for await (const out of translate(table, toStream(chunks))) parts.push(out);
  return new TextDecoder().decode(concatBytes(parts));
}

test("stress: one 8192-code-point source vs 1MiB of 'a'", async () => {
  // The single source is a^8191 + "b"; the input never contains "b", so
  // nothing matches and the output equals the input. A naive matcher would
  // re-probe an ~8191-long prefix at every position (O(N*L)); here the
  // reversed automaton stays at the root for every "a" (the reversed source
  // starts with "b"), so each input code point costs O(1).
  const entries: PhraseEntry[] = [
    { source: "a".repeat(8191) + "b", target: "BIG" },
  ];
  const t0 = performance.now();
  const table = compile(entries);
  const compileMs = performance.now() - t0;

  const text = "a".repeat(MIB);
  const t1 = performance.now();
  const out = await translateText(table, text, 4096);
  const translateMs = performance.now() - t1;

  assert.equal(out, text);
  console.log(
    `  [stress a^8191+b] compile=${compileMs.toFixed(1)}ms ` +
      `translate(1MiB)=${translateMs.toFixed(1)}ms`,
  );
});

test("stress: sources a^1..a^1999 vs 1MiB of 'a'", async () => {
  // Every position ends 1999 candidate matches. The kernel records only the
  // single longest one per position via the dictionary link (O(1)), never
  // enumerating candidates, and the greedy pass jumps 1999 code points per
  // commit, so work stays O(N) instead of O(N * candidates).
  const entries: PhraseEntry[] = [];
  for (let k = 1; k <= 1999; k++) {
    entries.push({ source: "a".repeat(k), target: `[${k}]` });
  }
  const t0 = performance.now();
  const table = compile(entries);
  const compileMs = performance.now() - t0;

  const n = MIB + 7;
  const text = "a".repeat(n);
  const t1 = performance.now();
  const out = await translateText(table, text, 4096);
  const translateMs = performance.now() - t1;

  const q = Math.floor(n / 1999);
  const r = n % 1999;
  const expected = "[1999]".repeat(q) + (r > 0 ? `[${r}]` : "");
  assert.equal(out, expected);
  console.log(
    `  [stress a^1..a^1999] compile=${compileMs.toFixed(1)}ms ` +
      `translate(1MiB)=${translateMs.toFixed(1)}ms`,
  );
});

test("long sources spanning window boundaries", async () => {
  // Sources of ~2000 code points (L = 2000+), text much larger than the 2L
  // window, so matches must be recognized across window boundaries.
  const rand = makeRandom(7);
  const leads = ["a", "b", "c", "你", "d", "e"];
  const entries: PhraseEntry[] = leads.map((lead, i) => {
    let source = lead;
    while (Array.from(source).length < 2000 + i * 37) {
      source += ["x", "y", "z", "🙂"][Math.floor(rand() * 4)];
    }
    return { source, target: `<T${i}>` };
  });
  const seen = new Set<string>();
  for (const e of entries) {
    assert.ok(!seen.has(e.source));
    seen.add(e.source);
  }

  let text = "";
  for (let i = 0; i < 15; i++) {
    text += entries[Math.floor(rand() * entries.length)]!.source;
    text += "noise ";
  }
  text += entries[0]!.source.slice(0, 500); // trailing partial source

  const expected = referenceTranslate(entries, text);
  const bytes = encode(text);
  const whole = await runTranslate(entries, [bytes]);
  assert.equal(whole, expected);
  const chunked = await runTranslate(entries, chunkBytes(bytes, [4096]));
  assert.equal(chunked, expected);
  const random = await runTranslate(entries, randomChunks(bytes, rand, 1000));
  assert.equal(random, expected);
});

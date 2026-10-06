import { test } from "node:test";
import assert from "node:assert/strict";
import type { PhraseEntry } from "../src/index.ts";
import {
  bytewiseChunks,
  chunkBytes,
  encode,
  makeRandom,
  randomChunks,
  referenceTranslate,
  runTranslate,
  wholeChunk,
} from "./helpers.ts";

async function assertAllChunkings(
  entries: readonly PhraseEntry[],
  text: string,
  seed = 1,
): Promise<void> {
  const bytes = encode(text);
  const expected = referenceTranslate(entries, text);
  const rand = makeRandom(seed);
  const chunkings: Array<[string, Uint8Array[]]> = [
    ["whole", wholeChunk(bytes)],
    ["bytewise", bytewiseChunks(bytes)],
    ["random", randomChunks(bytes, rand)],
    ["pairs", chunkBytes(bytes, [2])],
  ];
  for (const [name, chunks] of chunkings) {
    const actual = await runTranslate(entries, chunks);
    assert.equal(actual, expected, `chunking=${name} text=${JSON.stringify(text)}`);
  }
}

test("shared prefixes: longest match wins", async () => {
  const entries: PhraseEntry[] = [
    { source: "a", target: "X" },
    { source: "ab", target: "Y" },
    { source: "abc", target: "Z" },
  ];
  await assertAllChunkings(entries, "abc");
  await assertAllChunkings(entries, "ababc");
  await assertAllChunkings(entries, "abcdabc");
  await assertAllChunkings(entries, "aababcab");
});

test("containment relations", async () => {
  const entries: PhraseEntry[] = [
    { source: "he", target: "1" },
    { source: "hell", target: "2" },
    { source: "hello", target: "3" },
    { source: "hello world", target: "4" },
  ];
  await assertAllChunkings(entries, "hello world hello hell he");
  await assertAllChunkings(entries, "hellohello world");
});

test("multibyte characters", async () => {
  const entries: PhraseEntry[] = [
    { source: "你", target: "u" },
    { source: "你好", target: "hello" },
    { source: "你好吗", target: "howareyou" },
    { source: "🙂", target: "e" },
    { source: "🙂🙂", target: "E" },
    { source: "a🙂", target: "ae" },
  ];
  await assertAllChunkings(entries, "你好吗，你好！你🙂🙂🙂 a🙂 🙂a");
  await assertAllChunkings(entries, "你好🙂🙂a🙂你");
});

test("hidden match under a longer ending match", async () => {
  // "bc" is shadowed by "abc" as the longest match ending at position 3,
  // yet the greedy result must use "bc" after committing "za".
  const entries: PhraseEntry[] = [
    { source: "za", target: "P" },
    { source: "abc", target: "Q" },
    { source: "bc", target: "R" },
  ];
  await assertAllChunkings(entries, "zabc");
  assert.equal(referenceTranslate(entries, "zabc"), "PR");
});

test("end of input: long phrase incomplete, short phrase still applies", async () => {
  const entries: PhraseEntry[] = [
    { source: "a", target: "x" },
    { source: "aaaaab", target: "T" },
  ];
  await assertAllChunkings(entries, "aaaaa");
  await assertAllChunkings(entries, "aaaaab");
  await assertAllChunkings(entries, "aaaaabaaaa");
});

test("end of input: unmatched residue preserved", async () => {
  const entries: PhraseEntry[] = [
    { source: "abcdef", target: "T" },
  ];
  await assertAllChunkings(entries, "abc");
  await assertAllChunkings(entries, "zabcde");
});

test("empty table passes input through unchanged", async () => {
  await assertAllChunkings([], "anything 你好 🙂 goes");
  await assertAllChunkings([], "");
});

test("empty input", async () => {
  await assertAllChunkings([{ source: "a", target: "b" }], "");
});

test("no word-boundary or normalization rules", async () => {
  const entries: PhraseEntry[] = [
    { source: "Ab ", target: "1" },
    { source: "b  c", target: "2" },
    { source: ",a", target: "3" },
  ];
  await assertAllChunkings(entries, "Ab  c,a ab  C,A");
});

test("randomized fuzz vs naive reference", async () => {
  const alphabet = ["a", "b", "c", "你", "🙂", " "];
  const rand = makeRandom(42);
  for (let round = 0; round < 60; round++) {
    const entryCount = 1 + Math.floor(rand() * 8);
    const entries: PhraseEntry[] = [];
    const seen = new Set<string>();
    while (entries.length < entryCount) {
      const len = 1 + Math.floor(rand() * 6);
      let source = "";
      for (let k = 0; k < len; k++) {
        source += alphabet[Math.floor(rand() * alphabet.length)];
      }
      if (seen.has(source)) continue;
      seen.add(source);
      entries.push({ source, target: `<${entries.length}>` });
    }
    let text = "";
    const textLen = Math.floor(rand() * 120);
    for (let k = 0; k < textLen; k++) {
      if (entries.length > 0 && rand() < 0.4) {
        text += entries[Math.floor(rand() * entries.length)]!.source;
      } else {
        text += alphabet[Math.floor(rand() * alphabet.length)];
      }
    }
    await assertAllChunkings(entries, text, 1000 + round);
  }
});

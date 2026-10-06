import { test } from "node:test";
import assert from "node:assert/strict";
import {
  naiveTranslate,
  runTranslate,
  wholeChunk,
  byteChunks,
  randomChunks,
} from "./helpers";
import type { Entry } from "../src/index";

const SHARED_PREFIX_ENTRIES: Entry[] = [
  { source: "abcd", target: "<T4>" },
  { source: "abc", target: "<T3>" },
  { source: "ab", target: "<T2>" },
  { source: "bc", target: "<T2b>" },
  { source: "a", target: "<T1>" },
];

const CONTAINMENT_ENTRIES: Entry[] = [
  { source: "he", target: "<he>" },
  { source: "she", target: "<she>" },
  { source: "her", target: "<her>" },
  { source: "hers", target: "<hers>" },
  { source: "herself", target: "<herself>" },
];

const MULTIBYTE_ENTRIES: Entry[] = [
  { source: "你好世界", target: "<HelloWorld>" },
  { source: "你好", target: "<Hello>" },
  { source: "🙂🙃", target: "<both>" },
  { source: "🙂", target: "<smile>" },
  { source: "élan", target: "<elan>" },
  { source: "é", target: "<e>" },
];

const CASES: Array<{ name: string; entries: Entry[]; text: string }> = [
  {
    name: "shared prefixes, longest wins",
    entries: SHARED_PREFIX_ENTRIES,
    text: "xxabcdyyabczzabbcaa",
  },
  {
    name: "short match pending, longer completes",
    entries: SHARED_PREFIX_ENTRIES,
    text: "ababcd",
  },
  {
    name: "long phrase unfinished at EOF, short match committed",
    entries: SHARED_PREFIX_ENTRIES,
    text: "ab",
  },
  {
    name: "partial prefix residue at EOF",
    entries: SHARED_PREFIX_ENTRIES,
    text: "zzabc",
  },
  {
    name: "containment relations",
    entries: CONTAINMENT_ENTRIES,
    text: "ushers herself he her hers herself shehe",
  },
  {
    name: "multibyte sources and targets",
    entries: MULTIBYTE_ENTRIES,
    text: "说你好世界!你好🙂🙃🙂élan é🙂🙃",
  },
  {
    name: "multibyte prefix residue at EOF",
    entries: MULTIBYTE_ENTRIES,
    text: "你好世",
  },
  {
    name: "no matches at all",
    entries: SHARED_PREFIX_ENTRIES,
    text: "xyz 123 🙂",
  },
  {
    name: "empty input",
    entries: SHARED_PREFIX_ENTRIES,
    text: "",
  },
  {
    name: "adjacent matches do not rematch output",
    entries: [
      { source: "aa", target: "aa" },
      { source: "a", target: "b" },
    ],
    text: "aaaa",
  },
  {
    name: "exact match, no normalization",
    entries: [{ source: "Ab ", target: "<X>" }],
    text: "Ab  ab Ab",
  },
];

for (const { name, entries, text } of CASES) {
  test(`correctness: ${name}`, async () => {
    const expected = naiveTranslate(entries, text);
    const whole = await runTranslate(entries, wholeChunk(text));
    const bytewise = await runTranslate(entries, byteChunks(text));
    const random1 = await runTranslate(entries, randomChunks(text, 1));
    const random2 = await runTranslate(entries, randomChunks(text, 999983, 7));
    assert.equal(whole, expected, "whole chunk");
    assert.equal(bytewise, expected, "byte-wise chunks");
    assert.equal(random1, expected, "random chunks seed=1");
    assert.equal(random2, expected, "random chunks seed=999983");
  });
}

test("random texts over a small alphabet match naive reference", async () => {
  const entries: Entry[] = [
    { source: "aaa", target: "<3>" },
    { source: "aa", target: "<2>" },
    { source: "ab", target: "<ab>" },
    { source: "bab", target: "<bab>" },
    { source: "b", target: "<b>" },
  ];
  const { mulberry32 } = await import("./helpers");
  const rand = mulberry32(42);
  const alphabet = ["a", "b", "c", "你", "🙂"];
  for (let trial = 0; trial < 30; trial++) {
    const len = 1 + Math.floor(rand() * 200);
    let text = "";
    for (let i = 0; i < len; i++) {
      text += alphabet[Math.floor(rand() * alphabet.length)];
    }
    const expected = naiveTranslate(entries, text);
    assert.equal(await runTranslate(entries, wholeChunk(text)), expected);
    assert.equal(await runTranslate(entries, byteChunks(text)), expected);
    assert.equal(await runTranslate(entries, randomChunks(text, trial + 7)), expected);
  }
});

test("empty table passes input through unchanged", async () => {
  const text = "abc你好🙂 xyz";
  assert.equal(await runTranslate([], wholeChunk(text)), text);
  assert.equal(await runTranslate([], byteChunks(text)), text);
});

test("compiled table is reusable across translations", async () => {
  const entries: Entry[] = [
    { source: "ab", target: "<AB>" },
    { source: "abc", target: "<ABC>" },
  ];
  const { compile, translate } = await import("../src/index");
  const table = compile(entries);
  const run = async (text: string) => {
    let out = "";
    const dec = new TextDecoder();
    for await (const piece of translate(table, wholeChunk(text))) {
      out += dec.decode(piece, { stream: true });
    }
    return out + dec.decode();
  };
  assert.equal(await run("xabcy"), "x<ABC>y");
  assert.equal(await run("ab"), "<AB>");
  assert.equal(await run("zabz"), "z<AB>z");
});

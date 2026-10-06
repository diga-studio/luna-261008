import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, translate } from "../src/index.ts";
import type { PhraseEntry } from "../src/index.ts";
import {
  bytewiseChunks,
  concatBytes,
  encode,
  referenceTranslate,
  runTranslate,
} from "./helpers.ts";

async function* toStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for await (const c of chunks) yield c;
}

async function translateOnce(
  table: ReturnType<typeof compile>,
  chunks: Uint8Array[],
): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const out of translate(table, toStream(chunks))) parts.push(out);
  return new TextDecoder().decode(concatBytes(parts));
}

test("one compiled table serves many translations", async () => {
  const entries: PhraseEntry[] = [
    { source: "你好", target: "hello" },
    { source: "世界", target: "world" },
    { source: "你", target: "u" },
  ];
  const table = compile(entries);
  const texts = ["你好世界", "你世界你好你好", "", "你的世界"];
  for (const text of texts) {
    const expected = referenceTranslate(entries, text);
    assert.equal(await translateOnce(table, [encode(text)]), expected);
    assert.equal(await translateOnce(table, bytewiseChunks(encode(text))), expected);
  }
  // And through the public helper as well.
  assert.equal(await runTranslate(entries, [encode("你好")]), "hello");
});

test("interleaved translations on one table do not share state", async () => {
  const entries: PhraseEntry[] = [
    { source: "aaaa", target: "A" },
    { source: "aa", target: "B" },
  ];
  const table = compile(entries);
  async function* slow(text: string, delay: number): AsyncIterable<Uint8Array> {
    for (const c of bytewiseChunks(encode(text))) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      yield c;
    }
  }
  const collect = async (text: string, delay: number) => {
    const parts: Uint8Array[] = [];
    for await (const out of translate(table, slow(text, delay))) parts.push(out);
    return new TextDecoder().decode(concatBytes(parts));
  };
  const [r1, r2] = await Promise.all([collect("aaaaaa", 1), collect("aaaaa", 0)]);
  assert.equal(r1, referenceTranslate(entries, "aaaaaa"));
  assert.equal(r2, referenceTranslate(entries, "aaaaa"));
});

test("compile rejects invalid entries", async () => {
  assert.throws(() => compile([{ source: "", target: "x" }]));
  assert.throws(() => compile([{ source: "x", target: "" }]));
  assert.throws(
    () =>
      compile([
        { source: "x", target: "1" },
        { source: "x", target: "2" },
      ]),
  );
});

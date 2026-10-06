import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, translate } from "../src/index.ts";
import type { PhraseEntry } from "../src/index.ts";
import {
  chunkBytes,
  concatBytes,
  encode,
  referenceTranslate,
} from "./helpers.ts";

/** A manually driven chunk source: chunks are pushed, then the stream ends. */
function makeSource() {
  const queue: Uint8Array[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  async function* stream(): AsyncIterable<Uint8Array> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = undefined;
    }
  }
  return {
    stream,
    push(chunk: Uint8Array) {
      queue.push(chunk);
      notify?.();
    },
    end() {
      ended = true;
      notify?.();
    },
  };
}

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

test("paused source: translation progresses past the buffering bound", { timeout: 20000 }, async () => {
  const entries: PhraseEntry[] = [
    { source: "abcdefgh", target: "X" },
    { source: "abc", target: "Y" },
    { source: "ab", target: "Z" },
    { source: "你好🙂", target: "N" },
  ];
  const L = 8; // longest source in code points
  const bound = 4 * L + 4096; // 4128 code points
  const unit = "abcdefgh 你好🙂 abc ab zz";
  const fullText = unit.repeat(400); // 25k+ code points
  const cps = Array.from(fullText);
  const prefixLength = 20000;
  assert.ok(prefixLength > bound);
  const prefix = cps.slice(0, prefixLength).join("");
  const rest = cps.slice(prefixLength).join("");

  const source = makeSource();
  let outputSeen = false;
  let resumed = false;
  const firstOutput = new Promise<void>((resolve) => {
    const check = () => (outputSeen ? resolve() : setImmediate(check));
    setImmediate(check);
  });

  // Drive the source: deliver the oversized prefix, pause until the
  // consumer observes output, then deliver the rest.
  const driver = (async () => {
    for (const chunk of chunkBytes(encode(prefix), [4096])) source.push(chunk);
    await firstOutput;
    resumed = true;
    for (const chunk of chunkBytes(encode(rest), [4096])) source.push(chunk);
    source.end();
  })();

  const table = compile(entries);
  const parts: Uint8Array[] = [];
  for await (const out of translate(table, source.stream())) {
    outputSeen = true;
    parts.push(out);
  }
  await driver;

  assert.ok(outputSeen, "no output was produced while the source was paused");
  assert.ok(resumed, "source never resumed: translation did not progress");
  const actual = new TextDecoder().decode(concatBytes(parts));
  assert.equal(actual, referenceTranslate(entries, fullText));
});

test("uncommitted input stays within 4L + 4096 code points", { timeout: 20000 }, async () => {
  // Identity targets make the emitted output equal to the committed input
  // prefix, so the committed length can be measured from the outside.
  const L = 5000;
  const entries: PhraseEntry[] = [
    { source: "a".repeat(L - 1) + "b", target: "a".repeat(L - 1) + "b" },
    { source: "ab", target: "ab" },
  ];
  const table = compile(entries);
  const bound = 4 * L + 4096;

  const fed = 50000;
  const source = makeSource();
  const iterator = translate(table, source.stream())[Symbol.asyncIterator]();

  const outputs: Uint8Array[] = [];
  let pending = iterator.next();
  for (const chunk of chunkBytes(encode("a".repeat(fed)), [4096])) {
    source.push(chunk);
  }
  // Pump until the generator goes quiet waiting for more input.
  for (;;) {
    const result = await Promise.race([pending, sleep(50)]);
    if (result === null) break;
    assert.ok(!result.done, "stream ended before the input did");
    outputs.push(result.value);
    pending = iterator.next();
  }

  const committedText = new TextDecoder().decode(concatBytes(outputs));
  const committed = Array.from(committedText).length;
  assert.ok(committed > 0, "no progress: nothing was committed");
  assert.ok(
    fed - committed <= bound,
    `uncommitted ${fed - committed} code points exceeds bound ${bound}`,
  );
  // Identity table: committed output must equal the input prefix.
  assert.equal(committedText, "a".repeat(committed));

  // Finish the stream and verify the complete result.
  source.push(encode("b"));
  source.end();
  for (;;) {
    const result = await pending;
    if (result.done) break;
    outputs.push(result.value);
    pending = iterator.next();
  }
  const full = new TextDecoder().decode(concatBytes(outputs));
  assert.equal(full, "a".repeat(fed) + "b");
});

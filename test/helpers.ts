import { compile, translate } from "../src/index";
import type { Entry } from "../src/index";

/** Naive whole-text left-to-right longest-match reference implementation. */
export function naiveTranslate(entries: readonly Entry[], text: string): string {
  const sources = entries.map((e) => Array.from(e.source));
  const cps = Array.from(text);
  let out = "";
  let i = 0;
  while (i < cps.length) {
    let best = -1;
    let bestLen = 0;
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      if (src.length <= bestLen || i + src.length > cps.length) continue;
      let ok = true;
      for (let j = 0; j < src.length; j++) {
        if (cps[i + j] !== src[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        best = s;
        bestLen = src.length;
      }
    }
    if (best >= 0) {
      out += entries[best].target;
      i += bestLen;
    } else {
      out += cps[i];
      i += 1;
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32) for reproducible random chunkings. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Feed the whole text as a single chunk. */
export async function* wholeChunk(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** Feed one byte per chunk (splits multi-byte characters everywhere). */
export async function* byteChunks(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    yield bytes.subarray(i, i + 1);
  }
}

/** Feed chunks of random byte length in [1, maxLen], seeded for reproducibility. */
export async function* randomChunks(
  text: string,
  seed: number,
  maxLen = 64,
): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const rand = mulberry32(seed);
  let i = 0;
  while (i < bytes.length) {
    const n = 1 + Math.floor(rand() * maxLen);
    yield bytes.subarray(i, i + n);
    i += n;
  }
}

/** Feed fixed-size byte chunks (default 4096, the allowed maximum). */
export async function* fixedChunks(
  text: string,
  size = 4096,
): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

/** Run the streaming translator and return the decoded output string. */
export async function runTranslate(
  entries: readonly Entry[],
  chunks: AsyncIterable<Uint8Array>,
): Promise<string> {
  const table = compile(entries);
  const out: Uint8Array[] = [];
  for await (const piece of translate(table, chunks)) {
    out.push(piece);
  }
  const total = out.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of out) {
    joined.set(p, off);
    off += p.length;
  }
  return new TextDecoder().decode(joined);
}

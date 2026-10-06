import { compile, translate } from "../src/index.ts";
import type { PhraseEntry } from "../src/index.ts";

/** Naive whole-text left-to-right longest-match reference implementation. */
export function referenceTranslate(
  entries: readonly PhraseEntry[],
  text: string,
): string {
  const sources = entries.map((e) => Array.from(e.source));
  const cps = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < cps.length) {
    let best = -1;
    let bestLength = 0;
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s]!;
      if (src.length <= bestLength || i + src.length > cps.length) continue;
      let ok = true;
      for (let k = 0; k < src.length; k++) {
        if (cps[i + k] !== src[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        best = s;
        bestLength = src.length;
      }
    }
    if (best >= 0) {
      out.push(entries[best]!.target);
      i += bestLength;
    } else {
      out.push(cps[i]!);
      i += 1;
    }
  }
  return out.join("");
}

/** Deterministic PRNG (mulberry32). */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits bytes into chunks, cycling through the given sizes. */
export function chunkBytes(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length]!;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    i++;
  }
  return chunks;
}

/** Whole input as a single chunk. */
export function wholeChunk(bytes: Uint8Array): Uint8Array[] {
  return [bytes];
}

/** One chunk per byte. */
export function bytewiseChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1));
  return chunks;
}

/** Random chunk boundaries (1..2*avg bytes each). */
export function randomChunks(
  bytes: Uint8Array,
  rand: () => number,
  avg = 7,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = 1 + Math.floor(rand() * 2 * avg);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

async function* toStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

/** Runs the kernel over the given chunks and returns the decoded output. */
export async function runTranslate(
  entries: readonly PhraseEntry[],
  chunks: Uint8Array[],
): Promise<string> {
  const table = compile(entries);
  const parts: Uint8Array[] = [];
  for await (const out of translate(table, toStream(chunks))) {
    parts.push(out);
  }
  return new TextDecoder().decode(concatBytes(parts));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

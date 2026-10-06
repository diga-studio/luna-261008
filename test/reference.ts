import { ALPHABET, Challenge, MAX_LENGTH, MIN_LENGTH } from "../src/types";

export function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) {
      prev[j] = cur[j];
    }
  }
  return prev[b.length];
}

const REF_ALPHABET = ALPHABET;
const REF_SIZE = ALPHABET.length;

function buildKmp(fragment: string): number[][] {
  const table: number[][] = [];
  for (let state = 0; state <= fragment.length; state++) {
    const row: number[] = [];
    for (const ch of REF_ALPHABET) {
      const candidate = fragment.slice(0, state) + ch;
      let next = 0;
      for (let len = Math.min(candidate.length, fragment.length); len > 0; len--) {
        if (candidate.endsWith(fragment.slice(0, len))) {
          next = len;
          break;
        }
      }
      row.push(next);
    }
    table.push(row);
  }
  return table;
}

const DIGIT_BIT = 1;
const SPECIAL_BIT = 2;

function charBit(ch: string): number {
  if (ch >= "0" && ch <= "9") {
    return DIGIT_BIT;
  }
  if (ch === "!" || ch === "@" || ch === "#") {
    return SPECIAL_BIT;
  }
  return 0;
}

export function referenceMinChanges(original: string, challenge: Challenge): number {
  const fragments = challenge.bannedFragments;
  const kmps = fragments.map(buildKmp);
  const fragOf = fragments.map((f) => f.length);
  const kCount = fragments.length;

  const keyOf = (
    i: number,
    j: number,
    last: number,
    run: number,
    flags: number,
    kmp: readonly number[],
  ): string => `${i},${j},${last},${run},${flags},${kmp.join(".")}`;

  interface Node {
    i: number;
    j: number;
    last: number;
    run: number;
    flags: number;
    kmp: number[];
    cost: number;
  }

  const dist = new Map<string, number>();
  const heap: Node[] = [];
  const push = (node: Node): void => {
    const key = keyOf(node.i, node.j, node.last, node.run, node.flags, node.kmp);
    const known = dist.get(key);
    if (known !== undefined && known <= node.cost) {
      return;
    }
    dist.set(key, node.cost);
    heap.push(node);
    let idx = heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[parent].cost <= heap[idx].cost) {
        break;
      }
      [heap[parent], heap[idx]] = [heap[idx], heap[parent]];
      idx = parent;
    }
  };
  const pop = (): Node => {
    const top = heap[0];
    const lastNode = heap.pop() as Node;
    if (heap.length > 0) {
      heap[0] = lastNode;
      let idx = 0;
      for (;;) {
        const left = idx * 2 + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < heap.length && heap[left].cost < heap[smallest].cost) {
          smallest = left;
        }
        if (right < heap.length && heap[right].cost < heap[smallest].cost) {
          smallest = right;
        }
        if (smallest === idx) {
          break;
        }
        [heap[smallest], heap[idx]] = [heap[idx], heap[smallest]];
        idx = smallest;
      }
    }
    return top;
  };

  push({ i: 0, j: 0, last: -1, run: 0, flags: 0, kmp: new Array(kCount).fill(0), cost: 0 });

  for (;;) {
    const node = pop();
    const key = keyOf(node.i, node.j, node.last, node.run, node.flags, node.kmp);
    if ((dist.get(key) as number) < node.cost) {
      continue;
    }
    if (
      node.i === original.length &&
      node.j >= MIN_LENGTH &&
      node.j <= MAX_LENGTH &&
      node.flags === (DIGIT_BIT | SPECIAL_BIT)
    ) {
      return node.cost;
    }
    if (node.i < original.length) {
      push({
        i: node.i + 1,
        j: node.j,
        last: node.last,
        run: node.run,
        flags: node.flags,
        kmp: node.kmp,
        cost: node.cost + 1,
      });
    }
    if (node.j >= MAX_LENGTH) {
      continue;
    }
    for (let c = 0; c < REF_SIZE; c++) {
      const ch = REF_ALPHABET[c];
      if (node.last === c && node.run >= 2) {
        continue;
      }
      const kmpNext: number[] = [];
      let banned = false;
      for (let k = 0; k < kCount; k++) {
        const next = kmps[k][node.kmp[k]][c];
        if (next === fragOf[k]) {
          banned = true;
          break;
        }
        kmpNext.push(next);
      }
      if (banned) {
        continue;
      }
      const nextFlags = node.flags | charBit(ch);
      const nextRun = node.last === c ? node.run + 1 : 1;
      push({
        i: node.i,
        j: node.j + 1,
        last: c,
        run: nextRun,
        flags: nextFlags,
        kmp: kmpNext,
        cost: node.cost + 1,
      });
      if (node.i < original.length) {
        const match = original[node.i] === ch;
        push({
          i: node.i + 1,
          j: node.j + 1,
          last: c,
          run: nextRun,
          flags: nextFlags,
          kmp: kmpNext,
          cost: node.cost + (match ? 0 : 1),
        });
      }
    }
  }
}

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

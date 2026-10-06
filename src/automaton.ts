import { ALPHABET, DIGITS, SPECIALS } from "./types";

export const ALPHABET_SIZE = ALPHABET.length;

const CHAR_TO_INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_TO_INDEX.set(ALPHABET[i], i);
}

const DIGIT_INDICES = new Set<number>();
for (const ch of DIGITS) {
  DIGIT_INDICES.add(CHAR_TO_INDEX.get(ch) as number);
}

const SPECIAL_INDICES = new Set<number>();
for (const ch of SPECIALS) {
  SPECIAL_INDICES.add(CHAR_TO_INDEX.get(ch) as number);
}

export function charToIndex(ch: string): number {
  const index = CHAR_TO_INDEX.get(ch);
  if (index === undefined) {
    throw new RangeError(`character not allowed: ${ch}`);
  }
  return index;
}

export function indexToChar(index: number): string {
  return ALPHABET[index];
}

export function isDigitIndex(index: number): boolean {
  return DIGIT_INDICES.has(index);
}

export function isSpecialIndex(index: number): boolean {
  return SPECIAL_INDICES.has(index);
}

export class ForbiddenAutomaton {
  readonly nodeCount: number;
  private readonly go: Int16Array;
  private readonly terminal: Uint8Array;

  constructor(fragments: readonly string[]) {
    const trie: number[][] = [new Array<number>(ALPHABET_SIZE).fill(-1)];
    const terminalFlags: boolean[] = [false];
    for (const fragment of fragments) {
      let node = 0;
      for (const ch of fragment) {
        const c = charToIndex(ch);
        if (trie[node][c] === -1) {
          trie[node][c] = trie.length;
          trie.push(new Array<number>(ALPHABET_SIZE).fill(-1));
          terminalFlags.push(false);
        }
        node = trie[node][c];
      }
      terminalFlags[node] = true;
    }

    const count = trie.length;
    const fail = new Int32Array(count);
    const queue: number[] = [];
    for (let c = 0; c < ALPHABET_SIZE; c++) {
      const next = trie[0][c];
      if (next !== -1) {
        fail[next] = 0;
        queue.push(next);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      for (let c = 0; c < ALPHABET_SIZE; c++) {
        const next = trie[node][c];
        if (next === -1) {
          continue;
        }
        let fallback = fail[node];
        while (fallback !== 0 && trie[fallback][c] === -1) {
          fallback = fail[fallback];
        }
        const candidate = trie[fallback][c];
        fail[next] = candidate !== -1 && candidate !== next ? candidate : 0;
        terminalFlags[next] = terminalFlags[next] || terminalFlags[fail[next]];
        queue.push(next);
      }
    }

    this.nodeCount = count;
    this.go = new Int16Array(count * ALPHABET_SIZE);
    this.terminal = new Uint8Array(count);
    for (let node = 0; node < count; node++) {
      this.terminal[node] = terminalFlags[node] ? 1 : 0;
      for (let c = 0; c < ALPHABET_SIZE; c++) {
        let target = trie[node][c];
        if (target === -1) {
          let fallback = fail[node];
          while (fallback !== 0 && trie[fallback][c] === -1) {
            fallback = fail[fallback];
          }
          target = trie[fallback][c];
        }
        this.go[node * ALPHABET_SIZE + c] = target === -1 ? 0 : target;
      }
    }
  }

  next(node: number, charIndex: number): number {
    return this.go[node * ALPHABET_SIZE + charIndex];
  }

  isTerminal(node: number): boolean {
    return this.terminal[node] === 1;
  }
}

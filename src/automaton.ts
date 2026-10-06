import { ALLOWED_CHARS } from "./types.js";

export const ALPHABET: readonly string[] = ALLOWED_CHARS.split("");
export const ALPHABET_SIZE = ALPHABET.length;

const CHAR_TO_INDEX = new Map<string, number>(
  ALPHABET.map((ch, index) => [ch, index] as const),
);

export function charIndex(ch: string): number {
  const index = CHAR_TO_INDEX.get(ch);
  if (index === undefined) {
    throw new Error(`非法字符 ${JSON.stringify(ch)}`);
  }
  return index;
}

/**
 * 对禁用片段（含“连续三个相同字符”的隐式禁用）构建 Aho-Corasick 自动机，
 * 供达标判定与求解器共用。
 */
export interface ForbiddenAutomaton {
  /** 节点数。 */
  readonly size: number;
  /** goto 表：size * ALPHABET_SIZE，行优先，值为下一节点下标。 */
  readonly next: Uint16Array;
  /** dead[i] 为 1 表示到达该节点即已命中某条禁用规则。 */
  readonly dead: Uint8Array;
}

export function buildAutomaton(
  forbiddenFragments: readonly string[],
): ForbiddenAutomaton {
  // 连续三个相同字符等价于 39 个长度为 3 的禁用片段。
  const patterns: string[] = [...forbiddenFragments];
  for (const ch of ALPHABET) {
    patterns.push(ch + ch + ch);
  }

  // 1. 构建 Trie。
  const trie: number[][] = [new Array<number>(ALPHABET_SIZE).fill(-1)];
  const terminal: boolean[] = [false];
  for (const pattern of patterns) {
    let node = 0;
    for (const ch of pattern) {
      const edge = charIndex(ch);
      let child = trie[node]![edge]!;
      if (child === -1) {
        child = trie.length;
        trie.push(new Array<number>(ALPHABET_SIZE).fill(-1));
        terminal.push(false);
        trie[node]![edge] = child;
      }
      node = child;
    }
    terminal[node] = true;
  }

  // 2. BFS 计算失败指针，并补全 goto 表（缺失边指向失败节点的对应转移）。
  const size = trie.length;
  const next = new Uint16Array(size * ALPHABET_SIZE);
  const dead = new Uint8Array(size);
  const fail = new Int32Array(size);
  const queue: number[] = [0];
  for (let edge = 0; edge < ALPHABET_SIZE; edge += 1) {
    const child = trie[0]![edge]!;
    next[edge] = child === -1 ? 0 : child;
    if (child !== -1) {
      queue.push(child);
    }
  }
  dead[0] = terminal[0] ? 1 : 0;
  for (let head = 1; head < queue.length; head += 1) {
    const node = queue[head]!;
    const fallback = fail[node]!;
    dead[node] = terminal[node] || dead[fallback] === 1 ? 1 : 0;
    const row = node * ALPHABET_SIZE;
    const fallbackRow = fallback * ALPHABET_SIZE;
    for (let edge = 0; edge < ALPHABET_SIZE; edge += 1) {
      const child = trie[node]![edge]!;
      if (child === -1) {
        next[row + edge] = next[fallbackRow + edge]!;
      } else {
        next[row + edge] = child;
        fail[child] = next[fallbackRow + edge]!;
        queue.push(child);
      }
    }
  }
  return { size, next, dead };
}

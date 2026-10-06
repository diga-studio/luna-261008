import {
  ALPHABET_SIZE,
  buildAutomaton,
  charIndex,
  ALPHABET,
} from "./automaton.js";
import { MAX_LENGTH, MIN_LENGTH, type RepairSuggestion } from "./types.js";

const INF = 0x7fff;

const OP_NONE = 0;
const OP_DELETE = 1;
const OP_INSERT = 2;
const OP_MATCH = 3;

/** 每个允许字符对“字符类型”标志位的贡献：bit0=数字，bit1=特殊符号。 */
const CHAR_FLAG: Uint8Array = (() => {
  const flags = new Uint8Array(ALPHABET_SIZE);
  for (let index = 0; index < ALPHABET_SIZE; index += 1) {
    const ch = ALPHABET[index]!;
    if (ch >= "0" && ch <= "9") {
      flags[index] = 1;
    } else if (ch === "!" || ch === "@" || ch === "#") {
      flags[index] = 2;
    }
  }
  return flags;
})();

/**
 * 在全部达标字符串中求全局最小编辑距离，并返回一个最优达标串。
 *
 * 状态 (i, j, flags, node)：已消费原串前 i 个字符、已生成目标串前 j 个字符、
 * 已收集的字符类型标志、Aho-Corasick 自动机所在节点（自动机同时负责
 * 禁用片段与“连续三个相同字符”约束）。所有转移都使 i+j 恰好多 1，
 * 因此按 i+j 递增顺序做一次 DAG 动态规划即可得到全局最优。
 *
 * 假定 source 与 forbiddenFragments 已通过校验；所有求解状态均为局部
 * 变量，函数返回后不保留任何数据。
 */
export function solveMinRepair(
  source: string,
  forbiddenFragments: readonly string[],
): RepairSuggestion {
  const automaton = buildAutomaton(forbiddenFragments);
  const nodeCount = automaton.size;
  const sourceLength = source.length;
  const sourceIndices = new Int32Array(sourceLength);
  for (let i = 0; i < sourceLength; i += 1) {
    sourceIndices[i] = charIndex(source[i]!);
  }

  // 转置 goto 表：transposed[c * nodeCount + node]，便于内层循环顺序访问。
  const transposed = new Uint16Array(ALPHABET_SIZE * nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    const row = node * ALPHABET_SIZE;
    for (let c = 0; c < ALPHABET_SIZE; c += 1) {
      transposed[c * nodeCount + node] = automaton.next[row + c]!;
    }
  }

  const jDim = MAX_LENGTH + 1;
  const flagDim = 4;
  const layerSize = jDim * flagDim * nodeCount;
  const stateCount = (sourceLength + 1) * layerSize;
  const dist = new Int16Array(stateCount).fill(INF);
  const parentState = new Int32Array(stateCount).fill(-1);
  const parentOp = new Uint8Array(stateCount);
  const parentChar = new Uint8Array(stateCount);

  const indexOf = (i: number, j: number, flags: number, node: number): number =>
    ((i * jDim + j) * flagDim + flags) * nodeCount + node;

  dist[indexOf(0, 0, 0, 0)] = 0;

  for (let sum = 0; sum <= sourceLength + MAX_LENGTH; sum += 1) {
    const iMin = Math.max(0, sum - MAX_LENGTH);
    const iMax = Math.min(sourceLength, sum);
    for (let i = iMin; i <= iMax; i += 1) {
      const j = sum - i;
      for (let flags = 0; flags < flagDim; flags += 1) {
        const rowStart = indexOf(i, j, flags, 0);
        // 删除原串第 i 个字符。
        if (i < sourceLength) {
          const targetRow = rowStart + layerSize;
          for (let node = 0; node < nodeCount; node += 1) {
            const cost = dist[rowStart + node]!;
            if (cost === INF) continue;
            const candidate = cost + 1;
            if (candidate < dist[targetRow + node]!) {
              dist[targetRow + node] = candidate;
              parentState[targetRow + node] = rowStart + node;
              parentOp[targetRow + node] = OP_DELETE;
            }
          }
        }
        if (j >= MAX_LENGTH) continue;
        // 插入 / 替换（含免费匹配）一个字符。
        for (let c = 0; c < ALPHABET_SIZE; c += 1) {
          const nextFlags = flags | CHAR_FLAG[c]!;
          const insertRow = indexOf(i, j + 1, nextFlags, 0);
          const canMatch = i < sourceLength;
          const matchCost = canMatch && sourceIndices[i] === c ? 0 : 1;
          const matchRow = canMatch
            ? indexOf(i + 1, j + 1, nextFlags, 0)
            : 0;
          const column = c * nodeCount;
          for (let node = 0; node < nodeCount; node += 1) {
            const cost = dist[rowStart + node]!;
            if (cost === INF) continue;
            const nextNode = transposed[column + node]!;
            if (automaton.dead[nextNode] === 1) continue;
            const insertCandidate = cost + 1;
            if (insertCandidate < dist[insertRow + nextNode]!) {
              dist[insertRow + nextNode] = insertCandidate;
              parentState[insertRow + nextNode] = rowStart + node;
              parentOp[insertRow + nextNode] = OP_INSERT;
              parentChar[insertRow + nextNode] = c;
            }
            if (canMatch) {
              const replaceCandidate = cost + matchCost;
              if (replaceCandidate < dist[matchRow + nextNode]!) {
                dist[matchRow + nextNode] = replaceCandidate;
                parentState[matchRow + nextNode] = rowStart + node;
                parentOp[matchRow + nextNode] = OP_MATCH;
                parentChar[matchRow + nextNode] = c;
              }
            }
          }
        }
      }
    }
  }

  // 终点：原串消费完毕，长度 12..20，数字与特殊符号齐全，自动机任意存活节点。
  let best = INF;
  let bestState = -1;
  for (let j = MIN_LENGTH; j <= MAX_LENGTH; j += 1) {
    const rowStart = indexOf(sourceLength, j, 3, 0);
    for (let node = 0; node < nodeCount; node += 1) {
      const cost = dist[rowStart + node]!;
      if (cost < best) {
        best = cost;
        bestState = rowStart + node;
      }
    }
  }
  if (best === INF) {
    // 规则保证可达（足够长的串总可避开有限禁用片段），此处仅为防御。
    throw new Error("未能找到达标字符串");
  }

  // 沿父指针回溯构造建议串。
  const chars: number[] = [];
  for (let state = bestState; parentOp[state] !== OP_NONE; ) {
    const op = parentOp[state]!;
    if (op === OP_INSERT || op === OP_MATCH) {
      chars.push(parentChar[state]!);
    }
    state = parentState[state]!;
  }
  chars.reverse();
  const suggestion = chars.map((c) => ALPHABET[c]!).join("");
  return { minEdits: best, suggestion };
}

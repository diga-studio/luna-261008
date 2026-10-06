/**
 * 测试用的独立基准实现：与被测代码不共享任何状态表示与自动机逻辑。
 *
 * 不构建 Trie / 失败指针，而是对每个禁用片段直接用字符串匹配维护
 * “当前末尾与该片段前缀的最长匹配长度”，再加上 (末字符, 连续长度)
 * 处理连续三同字符。状态为：
 *   (已消费原串长度, 已生成长度, 字符类型标志, 末字符, 连续长度, 各片段匹配进度)
 * 在该状态空间上跑 A*（启发函数为剩余长度缺口与无法免费获得的字符类型
 * 数目的下界，可采纳且一致）。仅用于小规模用例的交叉核对。
 */
import { ALLOWED_CHARS } from "../src/types.js";

const ALPHABET = ALLOWED_CHARS.split("");

function charFlag(ch: string): number {
  if (ch >= "0" && ch <= "9") return 1;
  if (ch === "!" || ch === "@" || ch === "#") return 2;
  return 0;
}

/** 全局最小编辑次数的独立基准（仅供小用例核对）。 */
export function baselineMinEdits(
  source: string,
  forbidden: readonly string[],
): number {
  const n = source.length;
  const suffixHasDigit = new Array<boolean>(n + 1).fill(false);
  const suffixHasSpecial = new Array<boolean>(n + 1).fill(false);
  for (let i = n - 1; i >= 0; i -= 1) {
    const flag = charFlag(source[i]!);
    suffixHasDigit[i] = suffixHasDigit[i + 1]! || flag === 1;
    suffixHasSpecial[i] = suffixHasSpecial[i + 1]! || flag === 2;
  }

  const heuristic = (i: number, j: number, flags: number): number => {
    const potential = j + (n - i);
    const deletes = Math.max(0, potential - 20);
    const inserts = Math.max(0, 12 - potential);
    let types = 0;
    if ((flags & 1) === 0 && !suffixHasDigit[i]) types += 1;
    if ((flags & 2) === 0 && !suffixHasSpecial[i]) types += 1;
    return deletes + Math.max(inserts, types);
  };

  // 追加字符后，某片段的“末尾最长前缀匹配”新进度；命中完整片段返回 -1。
  const advance = (fragment: string, progress: number, ch: string): number => {
    const text = fragment.slice(0, progress) + ch;
    for (let k = text.length; k >= 0; k -= 1) {
      if (k === fragment.length && text.endsWith(fragment)) {
        return -1;
      }
      if (k < fragment.length && text.endsWith(fragment.slice(0, k))) {
        return k;
      }
    }
    return 0;
  };

  interface State {
    i: number;
    j: number;
    flags: number;
    last: string; // "" 表示尚无字符
    run: number; // 末字符连续出现次数（0 表示尚无字符）
    progress: number[]; // 各禁用片段的匹配进度
  }

  const keyOf = (s: State): string =>
    `${s.i}|${s.j}|${s.flags}|${s.last}|${s.run}|${s.progress.join(",")}`;

  const dist = new Map<string, number>();
  const heapKeys: string[] = [];
  const heapCosts: number[] = [];
  const heapPrio: number[] = [];
  const push = (k: string, cost: number, prio: number): void => {
    heapKeys.push(k);
    heapCosts.push(cost);
    heapPrio.push(prio);
    let idx = heapKeys.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heapPrio[parent]! <= heapPrio[idx]!) break;
      [heapKeys[parent], heapKeys[idx]] = [heapKeys[idx]!, heapKeys[parent]!];
      [heapCosts[parent], heapCosts[idx]] = [heapCosts[idx]!, heapCosts[parent]!];
      [heapPrio[parent], heapPrio[idx]] = [heapPrio[idx]!, heapPrio[parent]!];
      idx = parent;
    }
  };
  const pop = (): [string, number] => {
    const topKey = heapKeys[0]!;
    const topCost = heapCosts[0]!;
    const lastKey = heapKeys.pop()!;
    const lastCost = heapCosts.pop()!;
    const lastPrio = heapPrio.pop()!;
    if (heapKeys.length > 0) {
      heapKeys[0] = lastKey;
      heapCosts[0] = lastCost;
      heapPrio[0] = lastPrio;
      let idx = 0;
      for (;;) {
        const left = idx * 2 + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < heapKeys.length && heapPrio[left]! < heapPrio[smallest]!) {
          smallest = left;
        }
        if (right < heapKeys.length && heapPrio[right]! < heapPrio[smallest]!) {
          smallest = right;
        }
        if (smallest === idx) break;
        [heapKeys[idx], heapKeys[smallest]] = [heapKeys[smallest]!, heapKeys[idx]!];
        [heapCosts[idx], heapCosts[smallest]] = [heapCosts[smallest]!, heapCosts[idx]!];
        [heapPrio[idx], heapPrio[smallest]] = [heapPrio[smallest]!, heapPrio[idx]!];
        idx = smallest;
      }
    }
    return [topKey, topCost];
  };

  const relax = (s: State, cost: number): void => {
    const k = keyOf(s);
    if (cost < (dist.get(k) ?? Infinity)) {
      dist.set(k, cost);
      push(k, cost, cost + heuristic(s.i, s.j, s.flags));
    }
  };

  const parseKey = (k: string): State => {
    const parts = k.split("|");
    return {
      i: Number(parts[0]),
      j: Number(parts[1]),
      flags: Number(parts[2]),
      last: parts[3]!,
      run: Number(parts[4]),
      progress: parts[5] === "" ? [] : parts[5]!.split(",").map(Number),
    };
  };

  relax(
    { i: 0, j: 0, flags: 0, last: "", run: 0, progress: forbidden.map(() => 0) },
    0,
  );

  while (heapKeys.length > 0) {
    const [k, cost] = pop();
    if (cost !== dist.get(k)) continue;
    const state = parseKey(k);
    if (
      state.i === n &&
      state.j >= 12 &&
      state.j <= 20 &&
      state.flags === 3
    ) {
      return cost;
    }
    if (state.i < n) {
      relax({ ...state, i: state.i + 1 }, cost + 1);
    }
    if (state.j < 20) {
      for (const ch of ALPHABET) {
        // 连续三同字符检查。
        if (state.last === ch && state.run >= 2) continue;
        // 禁用片段检查。
        const nextProgress = new Array<number>(forbidden.length);
        let hit = false;
        for (let f = 0; f < forbidden.length; f += 1) {
          const advanced = advance(forbidden[f]!, state.progress[f]!, ch);
          if (advanced === -1) {
            hit = true;
            break;
          }
          nextProgress[f] = advanced;
        }
        if (hit) continue;
        const next: State = {
          i: state.i,
          j: state.j + 1,
          flags: state.flags | charFlag(ch),
          last: ch,
          run: state.last === ch ? state.run + 1 : 1,
          progress: nextProgress,
        };
        // 插入。
        relax(next, cost + 1);
        // 替换 / 匹配。
        if (state.i < n) {
          const matchCost = source[state.i] === ch ? 0 : 1;
          relax({ ...next, i: state.i + 1 }, cost + matchCost);
        }
      }
    }
  }
  throw new Error("基准求解失败");
}

/** 经典 Levenshtein 距离（插入/删除/替换各计 1），用于核对建议串可达性。 */
export function levenshtein(a: string, b: string): number {
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

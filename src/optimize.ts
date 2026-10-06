/**
 * 对一批线索求全局最优完整分配（动态规划，精确解）。
 *
 * 状态：每名销售的本批新分配数向量（决定均衡值）。
 * 同一计数向量下只保留步数序列字典序最小的路径：
 * 完整方案按步数序列逐条比较，首个不同处即分胜负，
 * 因此到达同一计数向量的较差前缀不可能在后续翻盘。
 * 步数序列相同时，轮转起点的演化也完全相同（起点由初始起点与步数唯一决定），
 * 故状态无需包含起点。
 */

interface PathState {
  /** 每名销售的本批新分配数。 */
  counts: number[];
  /** 当前均衡值 sum((historical + counts)^2)。 */
  cost: number;
  /** 已处理线索中，每条成功分配的前进步数（无候选人的线索不记录）。 */
  steps: number[];
  /** 每条已处理线索分配给的 roster 下标，-1 表示未分配。 */
  assign: number[];
  /** 当前轮转起点（roster 下标）。 */
  start: number;
}

/** 步数序列字典序比较：a 更小返回负数。 */
function compareSteps(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 同一 DP 阶段内，a 是否优于 b（均衡值更小，或相等时步数字典序更小）。 */
function better(a: PathState, b: PathState): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  return compareSteps(a.steps, b.steps) < 0;
}

/**
 * @param historicalCounts 每名销售的历史累计分配数
 * @param rotationStart 本批开始时的轮转起点（roster 下标）
 * @param candidatesPerLead 每条线索的候选人 roster 下标列表（空数组表示无候选人）
 * @returns 与 candidatesPerLead 等长的数组：被选销售的 roster 下标，-1 表示未分配
 */
export function optimizeBatch(
  historicalCounts: number[],
  rotationStart: number,
  candidatesPerLead: number[][],
): number[] {
  const n = historicalCounts.length;
  const leadCount = candidatesPerLead.length;
  if (n === 0 || leadCount === 0) return new Array<number>(leadCount).fill(-1);

  let baseCost = 0;
  for (const h of historicalCounts) baseCost += h * h;

  const initial: PathState = {
    counts: new Array<number>(n).fill(0),
    cost: baseCost,
    steps: [],
    assign: [],
    start: ((rotationStart % n) + n) % n,
  };

  let states = new Map<string, PathState>();
  states.set(initial.counts.join(","), initial);

  for (let leadIndex = 0; leadIndex < leadCount; leadIndex++) {
    const candidates = candidatesPerLead[leadIndex];
    if (candidates.length === 0) {
      // 无候选人：保持未分配，不改变计数与轮转起点。
      for (const s of states.values()) s.assign.push(-1);
      continue;
    }
    const next = new Map<string, PathState>();
    for (const s of states.values()) {
      for (const repIndex of candidates) {
        const step = (repIndex - s.start + n) % n;
        const counts = s.counts.slice();
        counts[repIndex] += 1;
        const total = historicalCounts[repIndex] + counts[repIndex];
        const candidate: PathState = {
          counts,
          cost: s.cost + 2 * (total - 1) + 1,
          steps: [...s.steps, step],
          assign: [...s.assign, repIndex],
          start: (repIndex + 1) % n,
        };
        const key = counts.join(",");
        const existing = next.get(key);
        if (!existing || better(candidate, existing)) next.set(key, candidate);
      }
    }
    states = next;
  }

  let best: PathState | undefined;
  for (const s of states.values()) {
    if (!best || better(s, best)) best = s;
  }
  return best!.assign;
}

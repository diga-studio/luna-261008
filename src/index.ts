import type { CompareResult, CompareStats, ReplayResult, Scenario, SimInput } from "./types.js";
import { runSimulation } from "./simulate.js";

export * from "./types.js";

/** 执行一轮仿真，返回保留步骤的时序与各 case 完成时间。 */
export function replay(
  input: SimInput,
  scenario: Scenario,
  seed: number,
  round: number,
): ReplayResult {
  return runSimulation(input, scenario, seed, round, true);
}

interface RoundStats {
  mean: number;
  median: number;
}

/** 单轮统计：case 耗时（完成减到达）的均值与中位数。 */
function roundStats(input: SimInput, scenario: Scenario, seed: number, round: number): RoundStats {
  const { completions } = runSimulation(input, scenario, seed, round, false);
  const arrivals = new Map<string, number>();
  for (const c of input.cases) arrivals.set(c.id, c.arrival);
  const durations = completions.map((c) => c.completion - arrivals.get(c.caseId)!);
  durations.sort((a, b) => a - b);
  const n = durations.length;
  if (n === 0) return { mean: 0, median: 0 };
  let sum = 0;
  for (const d of durations) sum += d;
  const mid = n >> 1;
  const median = n % 2 === 1 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
  return { mean: sum / n, median };
}

/** 执行 rounds 轮基线与方案配对仿真，返回跨轮统计。 */
export function compare(
  input: SimInput,
  scenario: Scenario,
  seed: number,
  rounds: number,
): CompareResult {
  if (!Number.isInteger(rounds) || rounds < 100 || rounds > 10000) {
    throw new RangeError("rounds must be an integer between 100 and 10000");
  }
  let baseMean = 0;
  let baseMedian = 0;
  let scenMean = 0;
  let scenMedian = 0;
  for (let round = 0; round < rounds; round++) {
    const b = roundStats(input, {}, seed, round);
    const s = roundStats(input, scenario, seed, round);
    baseMean += b.mean;
    baseMedian += b.median;
    scenMean += s.mean;
    scenMedian += s.median;
  }
  const baseline: CompareStats = { mean: baseMean / rounds, median: baseMedian / rounds };
  const scen: CompareStats = { mean: scenMean / rounds, median: scenMedian / rounds };
  return {
    baseline,
    scenario: scen,
    diff: { mean: scen.mean - baseline.mean, median: scen.median - baseline.median },
  };
}

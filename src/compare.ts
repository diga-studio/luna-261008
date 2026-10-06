import type { CompareResult, Scenario, SimulationInput } from "./types";
import { replay } from "./replay";

interface RoundStats {
  mean: number;
  median: number;
}

/** Per-round mean/median of case durations (completion - arrival). */
function roundStats(input: SimulationInput, completions: Record<string, number>): RoundStats {
  const durations: number[] = [];
  for (const caseDef of input.cases) {
    const completion = completions[caseDef.id];
    if (completion === undefined) {
      throw new Error(`missing completion for case "${caseDef.id}"`);
    }
    durations.push(completion - caseDef.arrival);
  }
  durations.sort((a, b) => a - b);
  const n = durations.length;
  let sum = 0;
  for (const d of durations) sum += d;
  const mid = n >> 1;
  const median = n % 2 === 1 ? (durations[mid] as number) : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
  return { mean: n === 0 ? 0 : sum / n, median: n === 0 ? 0 : median };
}

/**
 * Run `rounds` (100..10000) paired baseline/scenario simulations and aggregate
 * per-round mean and median case durations (completion - arrival).
 * Full trajectories are discarded after each round.
 */
export function compare(
  input: SimulationInput,
  scenario: Scenario,
  seed: number | string,
  rounds: number,
): CompareResult {
  if (!Number.isInteger(rounds) || rounds < 100 || rounds > 10000) {
    throw new Error("rounds must be an integer between 100 and 10000");
  }
  let baseMeanSum = 0;
  let baseMedianSum = 0;
  let scenMeanSum = 0;
  let scenMedianSum = 0;
  for (let round = 0; round < rounds; round++) {
    // Trajectories are discarded after each round; only the aggregates survive.
    const base = roundStats(input, replay(input, {}, seed, round).completions);
    const scen = roundStats(input, replay(input, scenario, seed, round).completions);
    baseMeanSum += base.mean;
    baseMedianSum += base.median;
    scenMeanSum += scen.mean;
    scenMedianSum += scen.median;
  }
  const baseline = { mean: baseMeanSum / rounds, median: baseMedianSum / rounds };
  const scenarioSide = { mean: scenMeanSum / rounds, median: scenMedianSum / rounds };
  return {
    baseline,
    scenario: scenarioSide,
    diff: {
      mean: scenarioSide.mean - baseline.mean,
      median: scenarioSide.median - baseline.median,
    },
  };
}

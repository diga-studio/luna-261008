import {
  INITIAL_RECOMMENDATION_LBS,
  RECOMMENDATION_STEP_LBS,
  SEGMENTS_PER_CYCLE,
  SETS_PER_SEGMENT,
  TARGET_REPS,
  SetEntry,
} from "./types";

/**
 * 由某动作整周期的组记录推导各段推荐重量。
 * sets[segIdx] 为该段（2 周，共 18 组）的记录，未记录为 null。
 * 规则：第一段 40 磅；仅当上一段 18 组都有记录、次数均 >= 10
 * 且实际重量均 >= 上一段推荐重量时，下一段 +5 磅，否则维持。
 */
export function deriveRecommendations(
  sets: Array<Array<SetEntry | null>>,
): number[] {
  const recommendations = new Array<number>(SEGMENTS_PER_CYCLE);
  recommendations[0] = INITIAL_RECOMMENDATION_LBS;
  for (let seg = 1; seg < SEGMENTS_PER_CYCLE; seg++) {
    const prev = recommendations[seg - 1] as number;
    const prevSets = sets[seg - 1] ?? [];
    let qualifies = prevSets.length >= SETS_PER_SEGMENT;
    if (qualifies) {
      for (let i = 0; i < SETS_PER_SEGMENT; i++) {
        const entry = prevSets[i];
        if (
          entry == null ||
          entry.reps < TARGET_REPS ||
          entry.weightLbs < prev
        ) {
          qualifies = false;
          break;
        }
      }
    }
    recommendations[seg] = qualifies ? prev + RECOMMENDATION_STEP_LBS : prev;
  }
  return recommendations;
}

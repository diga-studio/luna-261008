import type { Lead, RepState, TeamSnapshot } from "./types.js";

/** 单条技能是否命中：行业相同且预算落在 [minBudgetCents, maxBudgetCents)。 */
export function skillMatches(rep: RepState, lead: Lead): boolean {
  return rep.skills.some(
    (s) =>
      s.industry === lead.industry &&
      lead.budgetCents >= s.minBudgetCents &&
      lead.budgetCents < s.maxBudgetCents,
  );
}

/**
 * 计算一条线索的候选人：当前可用且任意一条技能命中的销售，
 * 按固定名单顺序返回 roster 下标。
 */
export function candidateIndices(snapshot: TeamSnapshot, lead: Lead): number[] {
  const result: number[] = [];
  for (let i = 0; i < snapshot.roster.length; i++) {
    const rep = snapshot.roster[i];
    if (rep.available && skillMatches(rep, lead)) result.push(i);
  }
  return result;
}

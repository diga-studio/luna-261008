import type { Lead, SalesRepState, Skill } from "./types.ts";
/** 行业相同且预算落在 [minBudget, maxBudget) 内即满足该条技能。 */
export declare function matchesSkill(skill: Skill, lead: Lead): boolean;
/** 当前可用且满足任意一条技能的销售即为候选人。 */
export declare function isCandidate(rep: SalesRepState, lead: Lead): boolean;
/** 按固定名单顺序返回一条线索的全部候选人下标。 */
export declare function candidateIndices(reps: readonly SalesRepState[], lead: Lead): number[];

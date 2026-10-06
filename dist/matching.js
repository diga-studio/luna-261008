/** 行业相同且预算落在 [minBudget, maxBudget) 内即满足该条技能。 */
export function matchesSkill(skill, lead) {
    return (skill.industry === lead.industry &&
        lead.budget >= skill.minBudget &&
        lead.budget < skill.maxBudget);
}
/** 当前可用且满足任意一条技能的销售即为候选人。 */
export function isCandidate(rep, lead) {
    return rep.available && rep.skills.some((skill) => matchesSkill(skill, lead));
}
/** 按固定名单顺序返回一条线索的全部候选人下标。 */
export function candidateIndices(reps, lead) {
    const result = [];
    for (let i = 0; i < reps.length; i++) {
        if (isCandidate(reps[i], lead))
            result.push(i);
    }
    return result;
}

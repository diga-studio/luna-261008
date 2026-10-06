import type { MatchingRules, Project, Talent } from "./types.js";

/**
 * 所有评分都用整数运算得到 floor(score * 10000)。
 * 参与运算的整数最大为 100000 * 10000 = 1e9，远小于 2^53，
 * 因此 number 类型的整数乘除结果是数学上精确的，不受浮点误差影响。
 */
function scaledFloor(numerator: number, denominator: number): number {
  return Math.floor((numerator * 10000) / denominator);
}

/** 标签匹配分：交集大小 / 并集大小。 */
function tagScore(talent: Talent, project: Project): number {
  let intersection = 0;
  for (const tag of talent.tags) {
    if (project.tags.has(tag)) intersection += 1;
  }
  const union = talent.tags.size + project.tags.size - intersection;
  return scaledFloor(intersection, union);
}

/** 质量分：质量值 / 500。 */
function qualityScore(talent: Talent): number {
  return scaledFloor(talent.quality, 500);
}

/** 预算适配分：min(1, 时薪/预算下限, 预算上限/时薪)。floor 与 min 可交换。 */
function budgetScore(talent: Talent, project: Project): number {
  return Math.min(
    10000,
    scaledFloor(talent.hourlyRate, project.budgetMin),
    scaledFloor(project.budgetMax, talent.hourlyRate),
  );
}

/** 可接单分：1 或 0。 */
function availabilityScore(talent: Talent): number {
  return talent.available ? 10000 : 0;
}

/** 工龄分：min(工龄, 20) / 20。 */
function experienceScore(talent: Talent): number {
  return scaledFloor(Math.min(talent.experienceYears, 20), 20);
}

/** 判断人才是否满足项目入选条件。 */
export function isEligible(
  talent: Talent,
  project: Project,
  rules: MatchingRules,
): boolean {
  if (project.denylist.has(talent.id)) return false;
  let sharesTag = false;
  for (const tag of talent.tags) {
    if (project.tags.has(tag)) {
      sharesTag = true;
      break;
    }
  }
  if (!sharesTag) return false;
  if (talent.quality >= rules.minQuality) return true;
  return project.allowlist.has(talent.id);
}

/** 计算人才对项目的精确整数总分。 */
export function scoreTalent(
  talent: Talent,
  project: Project,
  rules: MatchingRules,
): number {
  const w = rules.weights;
  return (
    tagScore(talent, project) * w.tagMatch +
    qualityScore(talent) * w.quality +
    budgetScore(talent, project) * w.budget +
    availabilityScore(talent) * w.availability +
    experienceScore(talent) * w.experience
  );
}

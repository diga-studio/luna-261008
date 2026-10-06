import { isEligible, scoreTalent } from "./scoring.js";
import type {
  MatchingRules,
  Project,
  Recommendation,
  Talent,
} from "./types.js";
import {
  validateProject,
  validateRules,
  validateTalent,
} from "./validate.js";

const DEFAULT_RULES: MatchingRules = {
  weights: {
    tagMatch: 20,
    quality: 20,
    budget: 20,
    availability: 20,
    experience: 20,
  },
  minQuality: 0,
};

const MAX_RECOMMENDATIONS = 20;

/**
 * CraftBridge 人才推荐组件。
 *
 * 人才资料与全局匹配规则只保存在进程内。推荐时对全部人才逐人评分并排序，
 * 不做任何缓存，因此资料或规则修改后的下一次推荐立即使用新值。
 */
export class CraftBridge {
  private readonly talents = new Map<number, Talent>();
  private rules: MatchingRules = DEFAULT_RULES;

  /** 整批装载人才，替换现有人才库。 */
  loadTalents(talents: readonly Talent[]): void {
    if (!Array.isArray(talents)) {
      throw new TypeError("人才列表必须是数组");
    }
    const next = new Map<number, Talent>();
    for (const talent of talents) {
      validateTalent(talent);
      if (next.has(talent.id)) {
        throw new TypeError(`人才编号重复: ${talent.id}`);
      }
      next.set(talent.id, talent);
    }
    this.talents.clear();
    for (const [id, talent] of next) {
      this.talents.set(id, talent);
    }
  }

  /** 替换（或新增）一名人才的资料。 */
  replaceTalent(talent: Talent): void {
    validateTalent(talent);
    this.talents.set(talent.id, talent);
  }

  /** 调整全局匹配规则。 */
  updateRules(rules: MatchingRules): void {
    validateRules(rules);
    this.rules = rules;
  }

  /** 为一个项目推荐最多 20 名人才。 */
  recommend(project: Project): Recommendation[] {
    validateProject(project);
    const scored: Recommendation[] = [];
    for (const talent of this.talents.values()) {
      if (!isEligible(talent, project, this.rules)) continue;
      scored.push({
        talentId: talent.id,
        totalScore: scoreTalent(talent, project, this.rules),
      });
    }
    scored.sort((a, b) => b.totalScore - a.totalScore || a.talentId - b.talentId);
    return scored.slice(0, MAX_RECOMMENDATIONS);
  }
}

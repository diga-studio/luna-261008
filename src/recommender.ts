import type { MatchRules, Project, Talent } from "./types";
import { scoreTalent } from "./scoring";
import { validateProject, validateRules, validateTalent } from "./validate";

const MAX_RECOMMENDATIONS = 20;

const DEFAULT_RULES: MatchRules = {
  weightTagMatch: 20,
  weightQuality: 20,
  weightBudgetFit: 20,
  weightAvailability: 20,
  weightExperience: 20,
  minQuality: 0,
};

/**
 * In-memory CraftBridge talent recommendation engine.
 *
 * Recommendations are always computed from the current talent pool and
 * rules, so updates take effect on the very next recommend() call.
 */
export class TalentRecommender {
  private readonly talents = new Map<number, Talent>();
  private rules: MatchRules = { ...DEFAULT_RULES };

  /** Replaces the entire talent pool. */
  loadTalents(talents: readonly Talent[]): void {
    const next = new Map<number, Talent>();
    for (const talent of talents) {
      validateTalent(talent);
      if (next.has(talent.id)) {
        throw new Error(`duplicate talent id ${talent.id}`);
      }
      next.set(talent.id, talent);
    }
    this.talents.clear();
    for (const [id, talent] of next) {
      this.talents.set(id, talent);
    }
  }

  /** Replaces the profile of one talent (matched by id). */
  replaceTalent(talent: Talent): void {
    validateTalent(talent);
    if (!this.talents.has(talent.id)) {
      throw new Error(`unknown talent id ${talent.id}`);
    }
    this.talents.set(talent.id, talent);
  }

  /** Updates the global matching rules. */
  setRules(rules: MatchRules): void {
    validateRules(rules);
    this.rules = { ...rules };
  }

  /** Recommends up to 20 talent ids for a project, best first. */
  recommend(project: Project): number[] {
    validateProject(project);
    const scored: Array<{ id: number; score: bigint }> = [];
    for (const talent of this.talents.values()) {
      const score = scoreTalent(talent, project, this.rules);
      if (score !== null) {
        scored.push({ id: talent.id, score });
      }
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) {
        return a.score > b.score ? -1 : 1;
      }
      return a.id - b.id;
    });
    return scored.slice(0, MAX_RECOMMENDATIONS).map((entry) => entry.id);
  }
}

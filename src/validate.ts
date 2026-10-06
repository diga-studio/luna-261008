import type { MatchRules, Project, Talent } from "./types";
import { PROFESSION_TAGS } from "./types";

const KNOWN_TAGS: ReadonlySet<string> = new Set(PROFESSION_TAGS);

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validateTags(
  tags: ReadonlySet<string>,
  owner: string,
): void {
  if (!(tags instanceof Set) || tags.size === 0) {
    throw new Error(`${owner}: tags must be a non-empty Set`);
  }
  for (const tag of tags) {
    if (!KNOWN_TAGS.has(tag)) {
      throw new Error(`${owner}: unknown profession tag "${String(tag)}"`);
    }
  }
}

function validateIdList(ids: ReadonlySet<number>, owner: string): void {
  if (!(ids instanceof Set)) {
    throw new Error(`${owner}: allow/block list must be a Set`);
  }
  for (const id of ids) {
    if (!isIntegerInRange(id, 1, Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${owner}: invalid talent id ${String(id)}`);
    }
  }
}

export function validateTalent(talent: Talent): void {
  if (!isIntegerInRange(talent.id, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error(`talent: id must be a positive integer, got ${String(talent.id)}`);
  }
  validateTags(talent.tags, `talent ${talent.id}`);
  if (!isIntegerInRange(talent.quality, 0, 500)) {
    throw new Error(`talent ${talent.id}: quality must be an integer 0..500`);
  }
  if (!isIntegerInRange(talent.hourlyRate, 1, 100000)) {
    throw new Error(`talent ${talent.id}: hourlyRate must be an integer 1..100000`);
  }
  if (typeof talent.available !== "boolean") {
    throw new Error(`talent ${talent.id}: available must be a boolean`);
  }
  if (!isIntegerInRange(talent.experienceYears, 0, 40)) {
    throw new Error(`talent ${talent.id}: experienceYears must be an integer 0..40`);
  }
}

export function validateProject(project: Project): void {
  validateTags(project.tags, "project");
  if (!isIntegerInRange(project.budgetMin, 1, 100000)) {
    throw new Error("project: budgetMin must be an integer 1..100000");
  }
  if (!isIntegerInRange(project.budgetMax, 1, 100000)) {
    throw new Error("project: budgetMax must be an integer 1..100000");
  }
  if (project.budgetMin > project.budgetMax) {
    throw new Error("project: budgetMin must not exceed budgetMax");
  }
  validateIdList(project.allowList, "project allowList");
  validateIdList(project.blockList, "project blockList");
}

export function validateRules(rules: MatchRules): void {
  const weights = [
    rules.weightTagMatch,
    rules.weightQuality,
    rules.weightBudgetFit,
    rules.weightAvailability,
    rules.weightExperience,
  ];
  for (const weight of weights) {
    if (!isIntegerInRange(weight, 0, 100)) {
      throw new Error("rules: weights must be non-negative integers");
    }
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total !== 100) {
    throw new Error(`rules: weights must sum to 100, got ${total}`);
  }
  if (!isIntegerInRange(rules.minQuality, 0, 500)) {
    throw new Error("rules: minQuality must be an integer 0..500");
  }
}

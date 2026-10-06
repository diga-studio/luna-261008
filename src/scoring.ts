import type { MatchRules, Project, Talent } from "./types";

const SCALE = 10000n;

/** floor(numerator * 10000 / denominator) with exact integer math. */
function scaledRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator * SCALE) / denominator;
}

function tagMatchScore(
  talentTags: ReadonlySet<string>,
  projectTags: ReadonlySet<string>,
): bigint {
  let intersection = 0;
  for (const tag of talentTags) {
    if (projectTags.has(tag)) {
      intersection += 1;
    }
  }
  const union = talentTags.size + projectTags.size - intersection;
  return scaledRatio(BigInt(intersection), BigInt(union));
}

function budgetFitScore(
  hourlyRate: number,
  budgetMin: number,
  budgetMax: number,
): bigint {
  const rate = BigInt(hourlyRate);
  const within = SCALE;
  const versusMin = scaledRatio(rate, BigInt(budgetMin));
  const versusMax = scaledRatio(BigInt(budgetMax), rate);
  const fit = within < versusMin ? within : versusMin;
  return fit < versusMax ? fit : versusMax;
}

/**
 * Computes the exact total score of a talent for a project under the given
 * rules. Returns null when the talent is not eligible.
 *
 * Eligibility: blocked ids are always excluded; the talent must share at
 * least one profession tag with the project and reach the quality threshold
 * (allow-listed ids are exempt from the quality threshold only).
 */
export function scoreTalent(
  talent: Talent,
  project: Project,
  rules: MatchRules,
): bigint | null {
  if (project.blockList.has(talent.id)) {
    return null;
  }
  let sharesTag = false;
  for (const tag of talent.tags) {
    if (project.tags.has(tag)) {
      sharesTag = true;
      break;
    }
  }
  if (!sharesTag) {
    return null;
  }
  if (!project.allowList.has(talent.id) && talent.quality < rules.minQuality) {
    return null;
  }

  const tagScore = tagMatchScore(talent.tags, project.tags);
  const qualityScore = scaledRatio(BigInt(talent.quality), 500n);
  const budgetScore = budgetFitScore(
    talent.hourlyRate,
    project.budgetMin,
    project.budgetMax,
  );
  const availabilityScore = talent.available ? SCALE : 0n;
  const cappedExperience = Math.min(talent.experienceYears, 20);
  const experienceScore = scaledRatio(BigInt(cappedExperience), 20n);

  return (
    tagScore * BigInt(rules.weightTagMatch) +
    qualityScore * BigInt(rules.weightQuality) +
    budgetScore * BigInt(rules.weightBudgetFit) +
    availabilityScore * BigInt(rules.weightAvailability) +
    experienceScore * BigInt(rules.weightExperience)
  );
}

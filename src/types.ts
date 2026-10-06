export type ProfessionTag =
  | "illustrator"
  | "animator"
  | "photographer"
  | "ux-designer";

export const PROFESSION_TAGS: readonly ProfessionTag[] = [
  "illustrator",
  "animator",
  "photographer",
  "ux-designer",
];

export interface Talent {
  /** Positive integer id. */
  id: number;
  /** Non-empty set of profession tags. */
  tags: ReadonlySet<ProfessionTag>;
  /** Public quality value: integer 0..500 (avg stars * 100, 0 = no reviews). */
  quality: number;
  /** Hourly rate in integer cents, 1..100000. */
  hourlyRate: number;
  /** Whether the talent is available for hire. */
  available: boolean;
  /** Years of experience, integer 0..40. */
  experienceYears: number;
}

export interface Project {
  /** Non-empty set of required profession tags. */
  tags: ReadonlySet<ProfessionTag>;
  /** Budget lower bound in integer cents, 1..100000, <= budgetMax. */
  budgetMin: number;
  /** Budget upper bound in integer cents, 1..100000. */
  budgetMax: number;
  /** Talent ids that bypass the quality threshold. */
  allowList: ReadonlySet<number>;
  /** Talent ids that are unconditionally excluded. */
  blockList: ReadonlySet<number>;
}

export interface MatchRules {
  /** Non-negative integer weights, must sum to 100. */
  weightTagMatch: number;
  weightQuality: number;
  weightBudgetFit: number;
  weightAvailability: number;
  weightExperience: number;
  /** Minimum quality value required to be eligible (allow list exempts). */
  minQuality: number;
}

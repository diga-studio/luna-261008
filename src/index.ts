import { Fraction } from "./fraction";
import { computeScore, RESTRICTION_THRESHOLD_HUNDREDTHS } from "./scorer";
import { Store } from "./store";
import { CreditResult, DimensionValues, Weights } from "./types";

export { CreditResult, DimensionValues, Weights } from "./types";

/**
 * Multi-dimensional credit scoring library. Authentication, rating direction
 * and appeal arbitration are handled by the caller; every call is trusted.
 */
export class CreditLibrary {
  private readonly store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** Replace the dimension weights of a business. */
  configure(businessId: string, weights: Weights): void {
    this.store.replaceWeights(businessId, weights);
  }

  /**
   * Append a new version to a logical rating, fully replacing its previous
   * dimension values. An empty map revokes the whole rating.
   */
  record(
    businessId: string,
    subjectId: string,
    ratingId: string,
    values: DimensionValues
  ): void {
    this.store.appendVersion(businessId, subjectId, ratingId, values);
  }

  /** Current credit score and invitation restriction for a subject. */
  credit(businessId: string, subjectId: string): CreditResult {
    const weights = this.store.getWeights(businessId);
    const effective = this.store
      .latestVersions(businessId, subjectId)
      .map((version) => version.values)
      .filter((values) => Object.keys(values).length > 0);
    const exact = computeScore(weights, effective);
    return {
      score: Number(exact.roundHalfUp()) / 100,
      restricted:
        exact.cmp(new Fraction(RESTRICTION_THRESHOLD_HUNDREDTHS)) < 0,
    };
  }

  close(): void {
    this.store.close();
  }
}

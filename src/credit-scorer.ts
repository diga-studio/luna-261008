import { computeCredit } from './scoring.js';
import { Store } from './store.js';
import type { CreditResult, DimensionValues, Weights } from './types.js';

/**
 * 多维信用评分库入口。
 * 鉴权、评级方向（商户评客户 / 客户评商户）与申诉裁决由调用方负责；
 * 本库接收可信的业务、主体、维度值与撤销指令。
 */
export class CreditScorer {
  private readonly store: Store;

  /** @param dbPath SQLite 文件路径，传 ':memory:' 使用内存库。 */
  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** 替换该业务的维度权重，标签名表示维度。 */
  configure(businessId: string, weights: Weights): void {
    for (const [label, weight] of Object.entries(weights)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight)) {
        throw new Error(`invalid weight for label ${label}: ${weight}`);
      }
    }
    this.store.replaceWeights(businessId, weights);
  }

  /**
   * 为一条逻辑评级追加新版本，完整替换此前的维度值。
   * 维度值为整数，以 0.01 分为单位。
   * 空映射表示申诉成功后撤销整条评级，不恢复旧版本。
   */
  record(
    businessId: string,
    subjectId: string,
    ratingId: string,
    values: DimensionValues,
  ): void {
    const owner = this.store.getSubjectOfRating(businessId, ratingId);
    if (owner !== undefined && owner !== subjectId) {
      throw new Error(
        `rating ${ratingId} already belongs to subject ${owner}`,
      );
    }
    for (const [label, value] of Object.entries(values)) {
      if (!Number.isInteger(value)) {
        throw new Error(
          `dimension value for label ${label} must be an integer, got ${value}`,
        );
      }
    }
    this.store.appendVersion({ businessId, ratingId, subjectId, values });
  }

  /** 返回当前信用分及是否限制邀评。 */
  credit(businessId: string, subjectId: string): CreditResult {
    const weights = this.store.getWeights(businessId);
    const latest = this.store
      .getLatestVersions(businessId, subjectId)
      .map((row) => row.values)
      .filter((values) => Object.keys(values).length > 0);
    return computeCredit(weights, latest);
  }

  close(): void {
    this.store.close();
  }
}

/** 专业标签：组件只服务这四类专业。 */
export type ProfessionTag =
  | "illustrator"
  | "animator"
  | "videographer"
  | "ux-designer";

export const PROFESSION_TAGS: readonly ProfessionTag[] = [
  "illustrator",
  "animator",
  "videographer",
  "ux-designer",
];

/** 人才资料。 */
export interface Talent {
  /** 正整数编号。 */
  id: number;
  /** 非空专业标签集合。 */
  tags: ReadonlySet<ProfessionTag>;
  /** 公开质量值：0-500 整数（平均星级*100，无评价为 0）。 */
  quality: number;
  /** 时薪，1-100000 整数美分。 */
  hourlyRate: number;
  /** 是否可接单。 */
  available: boolean;
  /** 工龄，0-40 整数年。 */
  experienceYears: number;
}

/** 全局匹配规则。 */
export interface MatchingRules {
  /** 五项非负整数权重，合计必须为 100。 */
  weights: {
    tagMatch: number;
    quality: number;
    budget: number;
    availability: number;
    experience: number;
  };
  /** 最低质量门槛（0-500 整数）。 */
  minQuality: number;
}

/** 项目需求。 */
export interface Project {
  /** 非空专业标签集合。 */
  tags: ReadonlySet<ProfessionTag>;
  /** 时薪预算下限（1-100000 整数美分）。 */
  budgetMin: number;
  /** 时薪预算上限（>= budgetMin，<= 100000）。 */
  budgetMax: number;
  /** 允许名单：仅豁免质量门槛。 */
  allowlist: ReadonlySet<number>;
  /** 禁止名单：无条件排除，优先于允许名单。 */
  denylist: ReadonlySet<number>;
}

/** 推荐结果中的一项。 */
export interface Recommendation {
  talentId: number;
  /** 精确整数总分（五项 floor(score*10000)*weight 之和）。 */
  totalScore: number;
}

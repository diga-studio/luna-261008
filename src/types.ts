/** 一条销售技能：行业 + 预算区间 [minBudgetCents, maxBudgetCents)，单位：整数美分。 */
export interface Skill {
  industry: string;
  minBudgetCents: number;
  maxBudgetCents: number;
}

/** 团队中一名销售的完整状态。 */
export interface RepState {
  id: string;
  available: boolean;
  skills: Skill[];
  /** 历史累计分配数，不因暂时不可用而清零。 */
  historicalCount: number;
}

/**
 * 团队快照：名单顺序固定，rotationStart 为轮转起点（roster 下标）。
 * 快照可读出、持久化并重新载入，跨批次结果与连续调用一致。
 */
export interface TeamSnapshot {
  roster: RepState[];
  rotationStart: number;
}

/** 一条 Hot 线索，行业与预算已由上游确认。 */
export interface Lead {
  id: string;
  industry: string;
  budgetCents: number;
}

/** 单条线索的分配结果；repId 为 null 表示无候选人、保持未分配。 */
export interface Assignment {
  leadId: string;
  repId: string | null;
}

/** 一批路由的结果：每条线索的分配 + 供下一批使用的最新团队状态。 */
export interface RouteResult {
  assignments: Assignment[];
  state: TeamSnapshot;
}

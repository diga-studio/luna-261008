/** 一条技能：行业 + 预算区间（下界包含、上界不包含，单位：整数美分）。 */
export interface Skill {
    industry: string;
    minBudget: number;
    maxBudget: number;
}
/** 快照中每名销售的状态。名单顺序即数组顺序，跨批次固定。 */
export interface SalesRepState {
    id: string;
    available: boolean;
    skills: Skill[];
    /** 历史累计分配数，不因暂时不可用而清零。 */
    assignedCount: number;
}
/** 团队快照：可读出、可重新载入。 */
export interface TeamSnapshot {
    reps: SalesRepState[];
    /** 轮转起点：固定名单中的下标。 */
    rotationStart: number;
}
/** 一条 Hot 线索，行业和预算已由上游确认。 */
export interface Lead {
    id: string;
    industry: string;
    /** 整数美分。 */
    budget: number;
}
/** 单条线索的分配结果；无候选人时 assignee 为 null。 */
export interface LeadAssignment {
    leadId: string;
    assignee: string | null;
}
/** 一批线索的路由结果。 */
export interface RouteResult {
    assignments: LeadAssignment[];
}

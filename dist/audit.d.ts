import type { Rule, RuleAudit } from './types.js';
/** 审查整份策略，对每条规则给出可达/完全遮蔽结论（按输入顺序返回）。 */
export declare function auditPolicy(rules: readonly Rule[]): RuleAudit[];

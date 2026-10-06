import type { Connection, MatchResult, Rule } from './types.js';
/** 判定一条具体连接：返回首个命中的规则及动作；无命中为默认 deny。 */
export declare function evaluateConnection(rules: readonly Rule[], conn: Connection): MatchResult;

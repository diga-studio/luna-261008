/** 允许出现的字符：小写字母、数字、!@# */
export const ALLOWED_CHARS =
  "abcdefghijklmnopqrstuvwxyz0123456789!@#" as const;

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 20;
export const MAX_SOURCE_LENGTH = 32;
export const MAX_FORBIDDEN_COUNT = 8;
export const MIN_FORBIDDEN_LENGTH = 2;
export const MAX_FORBIDDEN_LENGTH = 6;

/** 一道密码修复挑战题。 */
export interface Challenge {
  /** 禁用片段，0 至 8 个，每段 2 至 6 个允许字符。 */
  readonly forbiddenFragments: readonly string[];
}

/** 建议结果：最少修改次数与一个达标字符串。 */
export interface RepairSuggestion {
  /** 从原串到建议串的全局最小编辑距离（插入/删除/替换各计 1）。 */
  readonly minEdits: number;
  /** 一个恰好以 minEdits 次修改可达的达标字符串。 */
  readonly suggestion: string;
}

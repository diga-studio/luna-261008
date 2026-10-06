import { isCompliant } from "./compliance.js";
import { solveMinRepair } from "./solver.js";
import { validateChallenge, validateSource } from "./validate.js";
import type { Challenge, RepairSuggestion } from "./types.js";

export type { Challenge, RepairSuggestion } from "./types.js";
export {
  ALLOWED_CHARS,
  MIN_LENGTH,
  MAX_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_FORBIDDEN_COUNT,
  MIN_FORBIDDEN_LENGTH,
  MAX_FORBIDDEN_LENGTH,
} from "./types.js";

/** 判断练习字符串是否达标。非法输入抛出 Error。 */
export function checkCompliance(candidate: string, challenge: Challenge): boolean {
  validateChallenge(challenge);
  return isCompliant(candidate, challenge);
}

/** 返回达标所需的最少修改次数及一个达标字符串。非法输入抛出 Error。 */
export function suggestRepair(source: string, challenge: Challenge): RepairSuggestion {
  validateSource(source);
  validateChallenge(challenge);
  return solveMinRepair(source, challenge.forbiddenFragments);
}

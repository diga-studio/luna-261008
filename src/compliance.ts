import { ALPHABET, ALPHABET_SIZE, buildAutomaton, charIndex } from "./automaton.js";
import { MAX_LENGTH, MIN_LENGTH, type Challenge } from "./types.js";

const ALLOWED_SET = new Set<string>(ALPHABET);
const DIGIT_RE = /[0-9]/;
const SPECIAL_RE = /[!@#]/;

/**
 * 判断练习字符串是否达标：
 * 长度 12 至 20、仅含允许字符、至少一个数字、至少一个特殊符号（!@#）、
 * 无连续三个相同字符、不包含任何禁用片段（按连续子串判断）。
 */
export function isCompliant(candidate: string, challenge: Challenge): boolean {
  if (candidate.length < MIN_LENGTH || candidate.length > MAX_LENGTH) {
    return false;
  }
  for (const ch of candidate) {
    if (!ALLOWED_SET.has(ch)) {
      return false;
    }
  }
  if (!DIGIT_RE.test(candidate) || !SPECIAL_RE.test(candidate)) {
    return false;
  }
  const automaton = buildAutomaton(challenge.forbiddenFragments);
  let node = 0;
  for (const ch of candidate) {
    node = automaton.next[node * ALPHABET_SIZE + charIndex(ch)]!;
    if (automaton.dead[node] === 1) {
      return false;
    }
  }
  return true;
}

import {
  ALLOWED_CHARS,
  MAX_FORBIDDEN_COUNT,
  MAX_FORBIDDEN_LENGTH,
  MAX_SOURCE_LENGTH,
  MIN_FORBIDDEN_LENGTH,
  type Challenge,
} from "./types.js";

const ALLOWED_SET = new Set<string>(ALLOWED_CHARS.split(""));

function assertAllowedChars(value: string, what: string): void {
  for (const ch of value) {
    if (!ALLOWED_SET.has(ch)) {
      throw new Error(`${what} 包含非法字符 ${JSON.stringify(ch)}，仅允许小写字母、数字和 !@#`);
    }
  }
}

/** 校验原字符串，非法时抛出 Error。 */
export function validateSource(source: string): void {
  if (typeof source !== "string") {
    throw new Error("原字符串必须是字符串");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`原字符串最长 ${MAX_SOURCE_LENGTH} 个字符，当前为 ${source.length}`);
  }
  assertAllowedChars(source, "原字符串");
}

/** 校验题目，非法时抛出 Error。 */
export function validateChallenge(challenge: Challenge): void {
  if (challenge === null || typeof challenge !== "object") {
    throw new Error("题目必须是对象");
  }
  const fragments = challenge.forbiddenFragments;
  if (!Array.isArray(fragments)) {
    throw new Error("题目的 forbiddenFragments 必须是数组");
  }
  if (fragments.length > MAX_FORBIDDEN_COUNT) {
    throw new Error(`禁用片段最多 ${MAX_FORBIDDEN_COUNT} 个，当前为 ${fragments.length}`);
  }
  for (const fragment of fragments) {
    if (typeof fragment !== "string") {
      throw new Error("禁用片段必须是字符串");
    }
    if (fragment.length < MIN_FORBIDDEN_LENGTH || fragment.length > MAX_FORBIDDEN_LENGTH) {
      throw new Error(
        `禁用片段长度须在 ${MIN_FORBIDDEN_LENGTH} 至 ${MAX_FORBIDDEN_LENGTH} 之间，` +
          `当前片段 ${JSON.stringify(fragment)} 长度为 ${fragment.length}`,
      );
    }
    assertAllowedChars(fragment, "禁用片段");
  }
}

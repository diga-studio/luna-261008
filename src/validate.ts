import { PROFESSION_TAGS } from "./types.js";
import type { MatchingRules, Project, Talent } from "./types.js";

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function checkTags(tags: unknown, field: string): void {
  if (!(tags instanceof Set) || tags.size === 0) {
    throw new TypeError(`${field} 必须是非空专业标签集合`);
  }
  for (const tag of tags) {
    if (!PROFESSION_TAGS.includes(tag)) {
      throw new TypeError(`${field} 含有未知专业标签: ${String(tag)}`);
    }
  }
}

function checkIdList(list: unknown, field: string): void {
  if (!(list instanceof Set)) {
    throw new TypeError(`${field} 必须是编号集合`);
  }
  for (const id of list) {
    if (!isInt(id) || id <= 0) {
      throw new TypeError(`${field} 含有非法人才编号: ${String(id)}`);
    }
  }
}

/** 校验人才资料，非法时抛出 TypeError。 */
export function validateTalent(talent: Talent): void {
  if (talent === null || typeof talent !== "object") {
    throw new TypeError("人才资料必须是对象");
  }
  if (!isInt(talent.id) || talent.id <= 0) {
    throw new TypeError("人才编号必须是正整数");
  }
  checkTags(talent.tags, "人才专业标签");
  if (!isInt(talent.quality) || talent.quality < 0 || talent.quality > 500) {
    throw new TypeError("质量值必须是 0 到 500 的整数");
  }
  if (
    !isInt(talent.hourlyRate) ||
    talent.hourlyRate < 1 ||
    talent.hourlyRate > 100000
  ) {
    throw new TypeError("时薪必须是 1 到 100000 的整数美分");
  }
  if (typeof talent.available !== "boolean") {
    throw new TypeError("是否可接单必须是布尔值");
  }
  if (
    !isInt(talent.experienceYears) ||
    talent.experienceYears < 0 ||
    talent.experienceYears > 40
  ) {
    throw new TypeError("工龄必须是 0 到 40 的整数年");
  }
}

/** 校验全局匹配规则，非法时抛出 TypeError。 */
export function validateRules(rules: MatchingRules): void {
  if (rules === null || typeof rules !== "object") {
    throw new TypeError("匹配规则必须是对象");
  }
  const w = rules.weights;
  if (w === null || typeof w !== "object") {
    throw new TypeError("匹配规则必须包含权重对象");
  }
  const entries = [
    w.tagMatch,
    w.quality,
    w.budget,
    w.availability,
    w.experience,
  ];
  let sum = 0;
  for (const value of entries) {
    if (!isInt(value) || value < 0) {
      throw new TypeError("五项权重必须是非负整数");
    }
    sum += value;
  }
  if (sum !== 100) {
    throw new TypeError("五项权重合计必须等于 100");
  }
  if (!isInt(rules.minQuality) || rules.minQuality < 0 || rules.minQuality > 500) {
    throw new TypeError("最低质量门槛必须是 0 到 500 的整数");
  }
}

/** 校验项目需求，非法时抛出 TypeError。 */
export function validateProject(project: Project): void {
  if (project === null || typeof project !== "object") {
    throw new TypeError("项目需求必须是对象");
  }
  checkTags(project.tags, "项目专业标签");
  const { budgetMin, budgetMax } = project;
  for (const [field, value] of [
    ["预算下限", budgetMin],
    ["预算上限", budgetMax],
  ] as const) {
    if (!isInt(value) || value < 1 || value > 100000) {
      throw new TypeError(`${field}必须是 1 到 100000 的整数美分`);
    }
  }
  if (budgetMin > budgetMax) {
    throw new TypeError("预算下限不能大于预算上限");
  }
  checkIdList(project.allowlist, "允许名单");
  checkIdList(project.denylist, "禁止名单");
}

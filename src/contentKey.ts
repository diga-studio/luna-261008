import { AdContent, ContentPatch } from './types';

export const CONTENT_FIELDS = ['title', 'body', 'cta', 'backgroundColor', 'font'] as const;

/** 校验 patch 是任意非空字段子集，且值均为字符串。非法时抛出 TypeError。 */
export function validatePatch(patch: ContentPatch): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('patch 必须是对象');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TypeError('patch 必须至少包含一个字段');
  }
  for (const key of keys) {
    if (!(CONTENT_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(`未知字段: ${key}`);
    }
    if (typeof (patch as Record<string, unknown>)[key] !== 'string') {
      throw new TypeError(`字段 ${key} 必须是字符串`);
    }
  }
}

/** 用基线完整内容补全 patch 中的缺失字段，得到完整内容。 */
export function completeContent(base: AdContent, patch: ContentPatch): AdContent {
  return {
    title: patch.title ?? base.title,
    body: patch.body ?? base.body,
    cta: patch.cta ?? base.cta,
    backgroundColor: patch.backgroundColor ?? base.backgroundColor,
    font: patch.font ?? base.font,
  };
}

/** 完整内容的规范化身份串：字段次序无关，等价的完整/局部输入得到相同结果。 */
export function contentKey(content: AdContent): string {
  return JSON.stringify([
    content.title,
    content.body,
    content.cta,
    content.backgroundColor,
    content.font,
  ]);
}

/**
 * 归一化工具：不可见字符忽略、扩展字素簇切分、逐簇 NFKC + 小写。
 * 词条与待检查内容使用完全相同的规则。
 */

const IGNORED_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
]);

/** 判断一个码点（单码点字符串）是否为被忽略的不可见字符。 */
export function isIgnoredCodePoint(cp: number): boolean {
  return IGNORED_CODE_POINTS.has(cp);
}

/** 删除字符串中的不可见字符。 */
export function stripIgnored(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!IGNORED_CODE_POINTS.has(ch.codePointAt(0)!)) {
      out += ch;
    }
  }
  return out;
}

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

/** 把字符串切分为扩展字素簇，返回每个簇的半开区间（UTF-16 代码单元）。 */
export function graphemeSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const seg of graphemeSegmenter.segment(text)) {
    spans.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return spans;
}

/** 对单个扩展字素簇执行 NFKC + 不依赖区域设置的小写转换。 */
export function normalizeCluster(cluster: string): string {
  return cluster.normalize("NFKC").toLowerCase();
}

/** 词条归一化：先忽略不可见字符，再逐字素簇 NFKC + 小写。 */
export function normalizeWord(word: string): string {
  const stripped = stripIgnored(word);
  let out = "";
  for (const span of graphemeSpans(stripped)) {
    out += normalizeCluster(stripped.slice(span.start, span.end));
  }
  return out;
}

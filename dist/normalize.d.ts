/**
 * 归一化工具：不可见字符忽略、扩展字素簇切分、逐簇 NFKC + 小写。
 * 词条与待检查内容使用完全相同的规则。
 */
/** 判断一个码点（单码点字符串）是否为被忽略的不可见字符。 */
export declare function isIgnoredCodePoint(cp: number): boolean;
/** 删除字符串中的不可见字符。 */
export declare function stripIgnored(text: string): string;
/** 把字符串切分为扩展字素簇，返回每个簇的半开区间（UTF-16 代码单元）。 */
export declare function graphemeSpans(text: string): Array<{
    start: number;
    end: number;
}>;
/** 对单个扩展字素簇执行 NFKC + 不依赖区域设置的小写转换。 */
export declare function normalizeCluster(cluster: string): string;
/** 词条归一化：先忽略不可见字符，再逐字素簇 NFKC + 小写。 */
export declare function normalizeWord(word: string): string;

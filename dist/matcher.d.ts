/**
 * Aho-Corasick 多模式串匹配。
 * 在归一化后的文本上查找全部词条的全部出现，包括互相重叠的命中。
 */
export interface NormalizedWord {
    /** 词条在词库中的下标。 */
    wordIndex: number;
    /** 归一化后的词条文本（保证非空）。 */
    normalized: string;
}
export interface MatcherHit {
    wordIndex: number;
    /** 归一化文本中的半开区间（UTF-16 代码单元）。 */
    start: number;
    end: number;
}
export declare class Matcher {
    private nodes;
    private words;
    constructor(words: NormalizedWord[]);
    private insert;
    private buildFailures;
    /** 返回文本中全部命中（含重叠），按结束位置升序。 */
    findAll(text: string): MatcherHit[];
}

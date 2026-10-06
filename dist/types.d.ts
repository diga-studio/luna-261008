/** 半开区间 [start, end)，以 UTF-16 代码单元计数，指向原始输入文本。 */
export interface HitRange {
    start: number;
    end: number;
}
/** 一次命中：命中的词条（词库原文）及其在原文中的一组有序、已合并的位置区间。 */
export interface MatchHit {
    word: string;
    ranges: HitRange[];
}
/** 审核检查器：由词库构造，对内存中的内容执行检查。 */
export interface ModerationChecker {
    check(content: string): MatchHit[];
}

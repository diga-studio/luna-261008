/**
 * Markdown 可见文字抽取。
 *
 * 依据 CommonMark 0.31.2 解析（经由 micromark），把输入切分为若干“可见文字块”：
 * 强调内容与链接标签参与匹配；链接地址、行内代码、围栏代码块不参与。
 * 段落、可见文本中的换行、行内/围栏代码均为匹配边界，边界两侧不拼接。
 *
 * 每个可见码点携带其在原文中的半开区间（UTF-16 代码单元）：
 * 转义与实体解码出的字符覆盖该转义/实体的完整原文范围；
 * 被忽略的不可见字符在此直接丢弃，不留下位置。
 */
/** 一个可见码点及其在原文中的半开区间（UTF-16 代码单元）。 */
export interface SourceAtom {
    char: string;
    start: number;
    end: number;
}
/** 一段连续的可见文字（匹配在其内部进行，块与块之间是边界）。 */
export interface VisibleBlock {
    atoms: SourceAtom[];
}
/** 从 Markdown 原文中抽取全部可见文字块。 */
export declare function extractVisibleBlocks(source: string): VisibleBlock[];

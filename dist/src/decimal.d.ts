/**
 * 精确十进制定点运算：内部以 bigint 保存“值 × SCALE”。
 * 用量最多 6 位小数，损耗率换算因子分母为 10^6（百分数最多 4 位小数），
 * 故 SCALE = 10^12 可精确表示所有中间结果。
 */
export declare const SCALE: bigint;
/** 解析十进制文本为定点值（内部表示，值 × 10^12） */
export declare function parseDecimal(text: string, maxDecimals: number): bigint;
/** 解析整数十进制文本（根件需求），返回定点值 */
export declare function parseInteger(text: string): bigint;
/** 解析损耗率百分数文本（0~100，最多 4 位小数），返回“1 + rate/100”乘以 10^6 的因子 */
export declare function parseLossFactor(text: string | undefined): bigint;
/** 组件需求 = 父件数量(定点) × 用量(定点) × 损耗因子(10^6 缩放)，结果仍为定点值 */
export declare function multiplyLine(parentScaled: bigint, usageScaled: bigint, lossFactor: bigint): bigint;
/** 定点值向上取整到整件（返回整数 bigint） */
export declare function ceilToInteger(scaled: bigint): bigint;
/** 整数 bigint 转十进制文本 */
export declare function integerToText(value: bigint): string;

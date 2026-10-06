/**
 * 加权 L1 保序回归（内部使用）。
 *
 * 求解：minimize  sum_j w[j] * |y[j] - b[j]|
 *       subject to y[0] <= y[1] <= ... <= y[n-1]
 *
 * 返回所有最优解中逐分量最小（从而字典序最小）的那个。
 *
 * 算法：PAVA（Pool Adjacent Violators）。每个块维护“下加权中位数”
 * （使累积权重大于等于总权重一半的最小值），当相邻两块的下加权中位数
 * 左大于右时合并。块内用两个堆（左大根堆、右小根堆）维护加权中位数，
 * 合并时小堆并入大堆，总复杂度 O(n log^2 n)。
 *
 * 为让堆中元素互不相同（简化中位数不变式），键值使用
 * key = (value - minValue) * n + index 做平移放大，比较时天然带下标次序；
 * 还原时取 Math.floor(key / n) + minValue。数值范围远小于 2^53，精确安全。
 */
export declare function isotonicL1Min(b: readonly number[], w: readonly number[]): number[];

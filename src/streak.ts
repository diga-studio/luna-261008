const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 将 YYYY-MM-DD 解析为 UTC 日序号 */
function dayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/**
 * 计算连续日奖励总额。
 * 输入为活跃日期（YYYY-MM-DD，UTC 自然日），允许乱序与重复。
 * 全部活跃日期划分为最大连续段，每段每满 windowDays 天奖励 windowXp，
 * 不满一个窗口的余数不跨段累计。
 */
export function computeStreakXp(
  activeDates: string[],
  windowDays: number,
  windowXp: number,
): number {
  const unique = Array.from(new Set(activeDates)).sort();
  let total = 0;
  let runLength = 0;
  let previous: number | null = null;
  for (const date of unique) {
    const index = dayIndex(date);
    runLength = previous !== null && index === previous + 1 ? runLength + 1 : 1;
    total +=
      Math.floor(runLength / windowDays) * windowXp -
      Math.floor((runLength - 1) / windowDays) * windowXp;
    previous = index;
  }
  return total;
}

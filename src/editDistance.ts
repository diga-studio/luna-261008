/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 * 仅计单字符插入、删除、替换，各计 1；交换相邻字符不算一次修改。
 * 若提供 max 且真实距离超过 max，返回值保证大于 max（可能提前中止）。
 */
export function editDistance(a: string, b: string, max?: number): number {
  if (a === b) return 0;
  const rows = a.length;
  const cols = b.length;
  if (rows === 0) return cols;
  if (cols === 0) return rows;
  if (max !== undefined && Math.abs(rows - cols) > max) return max + 1;

  let prev = new Array<number>(cols + 1);
  let curr = new Array<number>(cols + 1);
  for (let j = 0; j <= cols; j++) prev[j] = j;

  for (let i = 1; i <= rows; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= cols; j++) {
      const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = prev[j] + 1;
      const insertion = curr[j - 1] + 1;
      curr[j] = Math.min(substitution, deletion, insertion);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (max !== undefined && rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[cols];
}

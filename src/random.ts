/**
 * 由 (seed, roundNo) 派生的确定性 PRNG（splitmix32）。
 * 只依赖实验 seed 与轮号，不依赖进程内随机状态，
 * 因此崩溃恢复后同一轮产生完全相同的抽样序列。
 */
export function deriveRoundRng(seed: number, roundNo: number): () => number {
  let state =
    (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(roundNo >>> 0, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

/** Fisher–Yates 均匀无放回抽样，顺序即选中顺序 */
export function sampleWithoutReplacement<T>(items: T[], count: number, rng: () => number): T[] {
  const arr = items.slice();
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

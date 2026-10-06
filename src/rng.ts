/**
 * 确定性抽样：由 (seed, round, caseId, stepIndex) 唯一决定，
 * 与容量、删除、调度及 case/样本输入顺序无关。
 * 采用 cyrb53 风格的 64 位混合哈希，输出 [0, modulo) 的均匀下标。
 */

/** 将一个非负安全整数按高低 32 位分两次混入。 */
function mixInt(h: [number, number], n: number): void {
  const lo = n % 4294967296;
  const hi = Math.floor(n / 4294967296);
  h[0] = Math.imul(h[0] ^ lo, 2654435761);
  h[1] = Math.imul(h[1] ^ lo, 1597334677);
  h[0] = Math.imul(h[0] ^ hi, 2654435761);
  h[1] = Math.imul(h[1] ^ hi, 1597334677);
}

export function sampleIndex(
  seed: number,
  round: number,
  caseId: string,
  stepIndex: number,
  modulo: number,
): number {
  const h: [number, number] = [0xdeadbeef, 0x41c6ce57];
  mixInt(h, seed);
  mixInt(h, round);
  for (let i = 0; i < caseId.length; i++) {
    h[0] = Math.imul(h[0] ^ caseId.charCodeAt(i), 2654435761);
    h[1] = Math.imul(h[1] ^ caseId.charCodeAt(i), 1597334677);
  }
  mixInt(h, stepIndex);
  h[0] = Math.imul(h[0] ^ (h[0] >>> 16), 2246822507) ^ Math.imul(h[1] ^ (h[1] >>> 13), 3266489909);
  h[1] = Math.imul(h[1] ^ (h[1] >>> 16), 2246822507) ^ Math.imul(h[0] ^ (h[0] >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h[1]) + (h[0] >>> 0);
  return combined % modulo;
}

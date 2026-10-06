import { MedianBag } from "./median";

/**
 * Weighted L1 isotonic regression on a chain:
 *   minimize sum_i weight[i] * |y[i] - target[i]|
 *   subject to y[0] <= y[1] <= ... <= y[m-1].
 *
 * Pool-adjacent-violators: scan left to right, merging adjacent blocks
 * whenever the left block's lower weighted median exceeds the right block's.
 * Each final block is assigned its lower weighted median, which yields the
 * componentwise-minimal (hence lexicographically smallest) optimal solution.
 *
 * Runs in O(m log m) time and O(m) memory.
 */
export function isotonicL1Min(
  target: ArrayLike<number>,
  weight: ArrayLike<number>,
): number[] {
  const m = target.length;
  if (m === 0) return [];

  const bags: MedianBag[] = [];
  const starts: number[] = [];

  for (let i = 0; i < m; i++) {
    const bag = new MedianBag();
    bag.add(target[i], weight[i]);
    bags.push(bag);
    starts.push(i);
    while (bags.length >= 2 && bags[bags.length - 2].median > bags[bags.length - 1].median) {
      const top = bags.pop() as MedianBag;
      bags[bags.length - 1].absorb(top);
      starts.pop();
    }
  }

  const y = new Array<number>(m);
  for (let b = 0; b < bags.length; b++) {
    const from = starts[b];
    const to = b + 1 < bags.length ? starts[b + 1] : m;
    const v = bags[b].median;
    for (let i = from; i < to; i++) y[i] = v;
  }
  return y;
}

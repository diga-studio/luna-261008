import { ERROR_RATE_DENOMINATOR, type AnomalyInterval } from "./types.js";

const BLOCK_TARGET = 1024;
const BLOCK_MAX = 2048;
const BLOCK_MIN = 512;

/**
 * One sorted chunk of event times. The absolute request/error counts at
 * entry i are the sum of all deltas of preceding blocks plus the prefix sum
 * of this block's deltas up to i. A time point t inside segment
 * [times[i], times[i+1]) is anomalous iff
 * ERROR_RATE_DENOMINATOR * errors(t) - total(t) > 0.
 */
interface Block {
  times: number[];
  dTotal: number[];
  dErr: number[];
  sumN: number;
  sumE: number;
  /** max(ERROR_RATE_DENOMINATOR * localE[i] - localN[i]) over the block. */
  maxLocalW: number;
}

function emptyBlock(): Block {
  return {
    times: [],
    dTotal: [],
    dErr: [],
    sumN: 0,
    sumE: 0,
    maxLocalW: -Infinity,
  };
}

function recompute(block: Block): void {
  let n = 0;
  let e = 0;
  let maxW = -Infinity;
  const len = block.times.length;
  for (let i = 0; i < len; i++) {
    n += block.dTotal[i]!;
    e += block.dErr[i]!;
    const w = ERROR_RATE_DENOMINATOR * e - n;
    if (w > maxW) maxW = w;
  }
  block.sumN = n;
  block.sumE = e;
  block.maxLocalW = maxW;
}

/** In-place iterative quicksort of a flat [time, dTotal, dErrors] array. */
function sortTriplets(a: number[]): void {
  const n = (a.length / 3) | 0;
  if (n < 2) return;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    let hi = stack.pop()!;
    let lo = stack.pop()!;
    while (lo < hi) {
      const pivot = a[((lo + hi) >> 1) * 3]!;
      let i = lo;
      let j = hi;
      do {
        while (a[i * 3]! < pivot) i++;
        while (a[j * 3]! > pivot) j--;
        if (i <= j) {
          for (let k = 0; k < 3; k++) {
            const tmp = a[i * 3 + k]!;
            a[i * 3 + k] = a[j * 3 + k]!;
            a[j * 3 + k] = tmp;
          }
          i++;
          j--;
        }
      } while (i <= j);
      // Recurse into the smaller side, iterate on the larger one.
      if (j - lo < hi - i) {
        if (lo < j) stack.push(lo, j);
        lo = i;
      } else {
        if (i < hi) stack.push(i, hi);
        hi = j;
      }
    }
  }
}

/**
 * Per-service store of window-count change events, organized as a sqrt
 * decomposed sorted list so that point updates cost O(sqrt(n)) and anomaly
 * enumeration stays proportional to the number of blocks plus the number of
 * anomalous segments.
 */
export class ServiceWindow {
  private blocks: Block[] = [];
  private totalEvents = 0;

  get eventCount(): number {
    return this.totalEvents;
  }

  addDelta(timeMs: number, dTotal: number, dErrors: number): void {
    if (dTotal === 0 && dErrors === 0) return;
    let blocks = this.blocks;
    if (blocks.length === 0) {
      blocks.push(emptyBlock());
    }
    // Rightmost block whose first time is <= timeMs; events earlier than every
    // block belong to the first block.
    let lo = 0;
    let hi = blocks.length - 1;
    let bi = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid]!.times[0]! <= timeMs) {
        bi = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let block = blocks[bi]!;
    // Binary search inside the block.
    let lo2 = 0;
    let hi2 = block.times.length - 1;
    let found = -1;
    while (lo2 <= hi2) {
      const mid = (lo2 + hi2) >> 1;
      const t = block.times[mid]!;
      if (t === timeMs) {
        found = mid;
        break;
      }
      if (t < timeMs) lo2 = mid + 1;
      else hi2 = mid - 1;
    }
    if (found >= 0) {
      const n = block.dTotal[found]! + dTotal;
      const e = block.dErr[found]! + dErrors;
      if (n === 0 && e === 0) {
        block.times.splice(found, 1);
        block.dTotal.splice(found, 1);
        block.dErr.splice(found, 1);
        this.totalEvents--;
      } else {
        block.dTotal[found] = n;
        block.dErr[found] = e;
      }
    } else {
      const at = lo2;
      block.times.splice(at, 0, timeMs);
      block.dTotal.splice(at, 0, dTotal);
      block.dErr.splice(at, 0, dErrors);
      this.totalEvents++;
    }

    if (block.times.length === 0) {
      blocks.splice(bi, 1);
      return;
    }
    recompute(block);
    if (block.times.length > BLOCK_MAX) {
      const half = block.times.length >> 1;
      const right: Block = {
        times: block.times.splice(half),
        dTotal: block.dTotal.splice(half),
        dErr: block.dErr.splice(half),
        sumN: 0,
        sumE: 0,
        maxLocalW: -Infinity,
      };
      recompute(block);
      recompute(right);
      blocks.splice(bi + 1, 0, right);
    } else if (block.times.length < BLOCK_MIN) {
      // Merge with a neighbour when the combined size stays reasonable.
      const next = blocks[bi + 1];
      const prev = blocks[bi - 1];
      const mergeIntoNext =
        next !== undefined &&
        (prev === undefined || next.times.length <= prev.times.length) &&
        block.times.length + next.times.length <= BLOCK_MAX;
      if (mergeIntoNext) {
        block.times.push(...next!.times);
        block.dTotal.push(...next!.dTotal);
        block.dErr.push(...next!.dErr);
        recompute(block);
        blocks.splice(bi + 1, 1);
      } else if (prev !== undefined && block.times.length + prev.times.length <= BLOCK_MAX) {
        prev.times.push(...block.times);
        prev.dTotal.push(...block.dTotal);
        prev.dErr.push(...block.dErr);
        recompute(prev);
        blocks.splice(bi, 1);
      }
    }
  }

  /**
   * Apply many deltas at once. `entries` is a flat array of
   * [time, dTotal, dErrors] triplets; it is sorted in place.
   */
  addDeltas(entries: number[]): void {
    if (entries.length === 0) return;
    const count = (entries.length / 3) | 0;
    if (count * BLOCK_TARGET <= this.totalEvents) {
      for (let i = 0; i < entries.length; i += 3) {
        this.addDelta(entries[i]!, entries[i + 1]!, entries[i + 2]!);
      }
      return;
    }
    // Bulk path: flatten, merge-sort with the new entries, re-chunk.
    const sorted = entries;
    sortTriplets(sorted);
    const times: number[] = [];
    const dN: number[] = [];
    const dE: number[] = [];
    let si = 0;
    const pushCombined = (t: number, dn: number, de: number) => {
      const last = times.length - 1;
      if (last >= 0 && times[last] === t) {
        dn += dN[last]!;
        de += dE[last]!;
        if (dn === 0 && de === 0) {
          times.pop();
          dN.pop();
          dE.pop();
          return;
        }
        dN[last] = dn;
        dE[last] = de;
      } else if (dn !== 0 || de !== 0) {
        times.push(t);
        dN.push(dn);
        dE.push(de);
      }
    };
    for (const block of this.blocks) {
      const bt = block.times;
      for (let i = 0; i < bt.length; i++) {
        const t = bt[i]!;
        while (si < count && sorted[si * 3]! <= t) {
          pushCombined(sorted[si * 3]!, sorted[si * 3 + 1]!, sorted[si * 3 + 2]!);
          si++;
        }
        pushCombined(t, block.dTotal[i]!, block.dErr[i]!);
      }
    }
    while (si < count) {
      pushCombined(sorted[si * 3]!, sorted[si * 3 + 1]!, sorted[si * 3 + 2]!);
      si++;
    }
    const blocks: Block[] = [];
    for (let i = 0; i < times.length; i += BLOCK_TARGET) {
      const block = emptyBlock();
      block.times = times.slice(i, i + BLOCK_TARGET);
      block.dTotal = dN.slice(i, i + BLOCK_TARGET);
      block.dErr = dE.slice(i, i + BLOCK_TARGET);
      recompute(block);
      blocks.push(block);
    }
    this.blocks = blocks;
    this.totalEvents = times.length;
  }

  queryAnomalies(fromMs: number, toMs: number): AnomalyInterval[] {
    const out: AnomalyInterval[] = [];
    if (fromMs >= toMs) return out;
    const k = ERROR_RATE_DENOMINATOR;
    let baseN = 0;
    let baseE = 0;
    const blocks = this.blocks;
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]!;
      if (k * baseE - baseN + block.maxLocalW > 0) {
        const nextStart = bi + 1 < blocks.length ? blocks[bi + 1]!.times[0]! : Infinity;
        const times = block.times;
        let localN = 0;
        let localE = 0;
        for (let i = 0; i < times.length; i++) {
          localN += block.dTotal[i]!;
          localE += block.dErr[i]!;
          const w = k * (baseE + localE) - (baseN + localN);
          if (w > 0) {
            const segStart = times[i]!;
            const segEnd = i + 1 < times.length ? times[i + 1]! : nextStart;
            const s = segStart > fromMs ? segStart : fromMs;
            const e = segEnd < toMs ? segEnd : toMs;
            if (s < e) {
              const last = out[out.length - 1];
              if (last !== undefined && last.endMs === s) last.endMs = e;
              else out.push({ startMs: s, endMs: e });
            }
          }
        }
      }
      baseN += block.sumN;
      baseE += block.sumE;
    }
    return out;
  }
}

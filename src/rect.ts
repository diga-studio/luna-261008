export interface Interval {
  lo: bigint;
  hi: bigint;
}

export type Rect = Interval[];

function intersect(a: Interval, b: Interval): Interval | null {
  const lo = a.lo > b.lo ? a.lo : b.lo;
  const hi = a.hi < b.hi ? a.hi : b.hi;
  return lo <= hi ? { lo, hi } : null;
}

function cloneRect(rect: Rect): Rect {
  return rect.map((i) => ({ lo: i.lo, hi: i.hi }));
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  for (let d = 0; d < a.length; d++) {
    const ai = a[d]!;
    const bi = b[d]!;
    if (ai.hi < bi.lo || bi.hi < ai.lo) {
      return false;
    }
  }
  return true;
}

export function subtractRect(rect: Rect, box: Rect): Rect[] {
  const pieces: Rect[] = [];
  const remaining = cloneRect(rect);
  for (let d = 0; d < rect.length; d++) {
    const inter = intersect(remaining[d]!, box[d]!);
    if (inter === null) {
      return [cloneRect(rect)];
    }
    const cur = remaining[d]!;
    if (cur.lo < inter.lo) {
      const piece = cloneRect(remaining);
      piece[d] = { lo: cur.lo, hi: inter.lo - 1n };
      pieces.push(piece);
    }
    if (inter.hi < cur.hi) {
      const piece = cloneRect(remaining);
      piece[d] = { lo: inter.hi + 1n, hi: cur.hi };
      pieces.push(piece);
    }
    remaining[d] = inter;
  }
  return pieces;
}

export function subtractBoxFromAll(regions: Rect[], box: Rect): Rect[] {
  const out: Rect[] = [];
  for (const region of regions) {
    if (rectsOverlap(region, box)) {
      for (const piece of subtractRect(region, box)) {
        out.push(piece);
      }
    } else {
      out.push(region);
    }
  }
  return out;
}

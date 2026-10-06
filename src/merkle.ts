/**
 * Merkle inclusion proofs (RFC 6962 style audit paths).
 */
import { innerHash } from "./hash.js";

/** One step of an inclusion proof. */
export interface ProofStep {
  /** Sibling hash, hex-encoded. */
  hash: string;
  /** Whether the sibling is on the left of the running hash. */
  side: "left" | "right";
}

/** Largest power of two strictly smaller than `n` (n >= 2). */
function largestSplit(n: number): number {
  let split = 1;
  while (split * 2 < n) {
    split *= 2;
  }
  return split;
}

/** Merkle Tree Hash over 0-based offsets [start, end); `leafAt` is 1-based. */
function rangeHash(
  leafAt: (position: number) => Buffer,
  start: number,
  end: number,
): Buffer {
  const n = end - start;
  if (n === 1) {
    return leafAt(start + 1);
  }
  const split = largestSplit(n);
  return innerHash(
    rangeHash(leafAt, start, start + split),
    rangeHash(leafAt, start + split, end),
  );
}

/**
 * Compute the inclusion proof for the leaf at 1-based position `seq`
 * within a tree of `count` leaves. `leafAt` must return the leaf hash
 * at a 1-based position.
 */
export function inclusionProof(
  seq: number,
  count: number,
  leafAt: (position: number) => Buffer,
): ProofStep[] {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(count) || seq < 1 || seq > count) {
    throw new RangeError("seq must be in [1, count]");
  }
  const steps: ProofStep[] = [];
  const build = (m: number, start: number, n: number): void => {
    if (n === 1) {
      return;
    }
    const split = largestSplit(n);
    if (m < split) {
      build(m, start, split);
      steps.push({
        hash: rangeHash(leafAt, start + split, start + n).toString("hex"),
        side: "right",
      });
    } else {
      build(m - split, start + split, n - split);
      steps.push({
        hash: rangeHash(leafAt, start, start + split).toString("hex"),
        side: "left",
      });
    }
  };
  build(seq - 1, 0, count);
  return steps;
}

/**
 * Verify an inclusion proof: recompute the root from `leaf` at 1-based
 * position `seq` in a tree of `count` leaves and compare with
 * `expectedRoot` (hex). Returns true iff the proof is valid.
 */
export function verifyInclusion(
  leaf: Buffer,
  seq: number,
  count: number,
  proof: ProofStep[],
  expectedRoot: Buffer,
): boolean {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(count) || seq < 1 || seq > count) {
    return false;
  }
  // Proof steps are ordered from the leaf level up to the root. Compute
  // the top-down level sequence first, then consume steps leaf-first.
  const levels: Array<{ n: number; m: number }> = [];
  {
    let n = count;
    let m = seq - 1;
    while (n > 1) {
      levels.push({ n, m });
      const split = largestSplit(n);
      if (m < split) {
        n = split;
      } else {
        m -= split;
        n -= split;
      }
    }
  }
  if (levels.length !== proof.length) {
    return false;
  }
  let root = leaf;
  for (let i = 0; i < levels.length; i += 1) {
    const { n, m } = levels[levels.length - 1 - i];
    const step = proof[i];
    const sibling = Buffer.from(step.hash, "hex");
    if (sibling.length !== 32) {
      return false;
    }
    const split = largestSplit(n);
    if (m < split) {
      if (step.side !== "right") {
        return false;
      }
      root = innerHash(root, sibling);
    } else {
      if (step.side !== "left") {
        return false;
      }
      root = innerHash(sibling, root);
    }
  }
  return root.equals(expectedRoot);
}

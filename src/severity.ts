import type { RawDrift } from './compare';
import type { Path, PathSegment, Severity } from './types';

type Relation = 'equal' | 'ancestor' | 'descendant' | 'none';

function segmentEqual(a: PathSegment, b: PathSegment): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'key' ? a.key === (b as typeof a).key : a.index === (b as typeof a).index;
}

/** Relate registered path r to drift path p: is r a prefix of p, or p a prefix of r? */
function relate(r: Path, p: Path): Relation {
  const n = Math.min(r.length, p.length);
  for (let i = 0; i < n; i += 1) {
    if (!segmentEqual(r[i], p[i])) return 'none';
  }
  if (r.length === p.length) return 'equal';
  return r.length < p.length ? 'ancestor' : 'descendant';
}

function isContainer(v: { readonly type: string } | undefined): boolean {
  return v !== undefined && (v.type === 'object' || v.type === 'array');
}

/**
 * A registered path counts as changed when some drift touches it or its
 * subtree, or when it sits inside an added/removed/replaced subtree. A drift
 * that only swaps one scalar for another leaves deeper registered paths
 * unreachable on both sides, which does not count as a change.
 */
function registeredChanged(r: Path, drifts: readonly RawDrift[]): boolean {
  for (const d of drifts) {
    const rel = relate(r, d.path);
    if (rel === 'equal' || rel === 'ancestor') return true;
    if (rel === 'descendant') {
      if (d.kind !== 'modified') return true;
      if (isContainer(d.baseline) || isContainer(d.current)) return true;
    }
  }
  return false;
}

/**
 * Classify every drift: Critical when a changed registered path is an
 * ancestor, descendant, or equal to the drift path; otherwise Medium for
 * modified and Low for added/removed.
 */
export function classify(drifts: readonly RawDrift[], registry: readonly Path[]): Severity[] {
  const changed = registry.map((r) => registeredChanged(r, drifts));
  return drifts.map((d) => {
    for (let j = 0; j < registry.length; j += 1) {
      if (changed[j] && relate(registry[j], d.path) !== 'none') {
        return 'critical';
      }
    }
    return d.kind === 'modified' ? 'medium' : 'low';
  });
}

/** Compliance score: 100 - 15*critical - 5*medium - 2*low, floored at 0. */
export function computeScore(severities: readonly Severity[]): number {
  let penalty = 0;
  for (const s of severities) {
    penalty += s === 'critical' ? 15 : s === 'medium' ? 5 : 2;
  }
  return Math.max(0, 100 - penalty);
}

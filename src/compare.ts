import { normalizedEqual } from './decimal';
import type { DriftKind, JsonNode, PathSegment, ReportedValue } from './types';

export interface RawDrift {
  readonly path: readonly PathSegment[];
  readonly kind: DriftKind;
  readonly baseline?: ReportedValue;
  readonly current?: ReportedValue;
}

/** Convert a subtree to a reported value; numbers keep their raw literals. */
export function toReported(node: JsonNode): ReportedValue {
  switch (node.kind) {
    case 'object': {
      const out: { [k: string]: ReportedValue } = {};
      for (const [k, v] of node.entries) {
        out[k] = toReported(v);
      }
      return { type: 'object', value: out };
    }
    case 'array':
      return { type: 'array', value: node.items.map(toReported) };
    case 'string':
      return { type: 'string', value: node.value };
    case 'number':
      return { type: 'number', raw: node.raw };
    case 'boolean':
      return { type: 'boolean', value: node.value };
    case 'null':
      return { type: 'null' };
  }
}

function scalarEqual(a: JsonNode, b: JsonNode): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'number':
      return normalizedEqual(a.num, (b as typeof a).num);
    case 'string':
      return a.value === (b as typeof a).value;
    case 'boolean':
      return a.value === (b as typeof a).value;
    case 'null':
      return true;
    default:
      return false;
  }
}

function diffInto(baseline: JsonNode, current: JsonNode, path: PathSegment[], out: RawDrift[]): void {
  if (baseline.kind === 'object' && current.kind === 'object') {
    for (const [k, v] of baseline.entries) {
      const other = current.entries.get(k);
      path.push({ kind: 'key', key: k });
      if (other === undefined) {
        out.push({ path: path.slice(), kind: 'removed', baseline: toReported(v) });
      } else {
        diffInto(v, other, path, out);
      }
      path.pop();
    }
    for (const [k, v] of current.entries) {
      if (!baseline.entries.has(k)) {
        path.push({ kind: 'key', key: k });
        out.push({ path: path.slice(), kind: 'added', current: toReported(v) });
        path.pop();
      }
    }
    return;
  }
  if (baseline.kind === 'array' && current.kind === 'array') {
    const shared = Math.min(baseline.items.length, current.items.length);
    for (let i = 0; i < shared; i += 1) {
      path.push({ kind: 'index', index: i });
      diffInto(baseline.items[i], current.items[i], path, out);
      path.pop();
    }
    for (let i = shared; i < baseline.items.length; i += 1) {
      path.push({ kind: 'index', index: i });
      out.push({ path: path.slice(), kind: 'removed', baseline: toReported(baseline.items[i]) });
      path.pop();
    }
    for (let i = shared; i < current.items.length; i += 1) {
      path.push({ kind: 'index', index: i });
      out.push({ path: path.slice(), kind: 'added', current: toReported(current.items[i]) });
      path.pop();
    }
    return;
  }
  if (!scalarEqual(baseline, current)) {
    out.push({
      path: path.slice(),
      kind: 'modified',
      baseline: toReported(baseline),
      current: toReported(current),
    });
  }
}

/**
 * Recursively diff two trees. A position present on only one side is a single
 * added/removed entry; a type change or scalar mismatch is a single modified
 * entry. Subtrees of such positions are never expanded.
 */
export function diffTrees(baseline: JsonNode, current: JsonNode): RawDrift[] {
  const out: RawDrift[] = [];
  diffInto(baseline, current, [], out);
  return out;
}

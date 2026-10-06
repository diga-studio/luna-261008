import { numberLiteralsEqual } from './decimal.js';
import type { ConfigNode, RawDiff } from './types.js';

class Differ {
  readonly diffs: RawDiff[] = [];
  private readonly path: Array<string | number> = [];

  compare(baseline: ConfigNode, current: ConfigNode): void {
    if (baseline.type === 'object' && current.type === 'object') {
      this.compareObjects(baseline, current);
      return;
    }
    if (baseline.type === 'array' && current.type === 'array') {
      this.compareArrays(baseline, current);
      return;
    }
    if (!scalarEqual(baseline, current)) {
      this.diffs.push({
        path: [...this.path],
        kind: 'modified',
        baseline,
        current,
      });
    }
  }

  private compareObjects(
    baseline: Extract<ConfigNode, { type: 'object' }>,
    current: Extract<ConfigNode, { type: 'object' }>,
  ): void {
    const currentByKey = new Map<string, ConfigNode>();
    for (const [key, value] of current.entries) currentByKey.set(key, value);
    const seen = new Set<string>();
    for (const [key, baseValue] of baseline.entries) {
      seen.add(key);
      const curValue = currentByKey.get(key);
      this.path.push(key);
      if (curValue === undefined) {
        this.diffs.push({ path: [...this.path], kind: 'removed', baseline: baseValue });
      } else {
        this.compare(baseValue, curValue);
      }
      this.path.pop();
    }
    for (const [key, curValue] of current.entries) {
      if (seen.has(key)) continue;
      this.path.push(key);
      this.diffs.push({ path: [...this.path], kind: 'added', current: curValue });
      this.path.pop();
    }
  }

  private compareArrays(
    baseline: Extract<ConfigNode, { type: 'array' }>,
    current: Extract<ConfigNode, { type: 'array' }>,
  ): void {
    const shared = Math.min(baseline.items.length, current.items.length);
    for (let i = 0; i < shared; i++) {
      this.path.push(i);
      this.compare(baseline.items[i], current.items[i]);
      this.path.pop();
    }
    for (let i = shared; i < baseline.items.length; i++) {
      this.path.push(i);
      this.diffs.push({ path: [...this.path], kind: 'removed', baseline: baseline.items[i] });
      this.path.pop();
    }
    for (let i = shared; i < current.items.length; i++) {
      this.path.push(i);
      this.diffs.push({ path: [...this.path], kind: 'added', current: current.items[i] });
      this.path.pop();
    }
  }
}

function scalarEqual(a: ConfigNode, b: ConfigNode): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'null':
      return true;
    case 'boolean':
      return a.value === (b as typeof a).value;
    case 'string':
      return a.value === (b as typeof a).value;
    case 'number':
      return numberLiteralsEqual(a.raw, (b as Extract<ConfigNode, { type: 'number' }>).raw);
    default:
      return false;
  }
}

/**
 * Recursively compares two parsed trees and returns raw differences
 * (kind + path + both reported values), without severity classification.
 * A position that is missing on one side, or whose value changed type,
 * produces exactly one diff without expanding the subtree.
 */
export function diffNodes(baseline: ConfigNode, current: ConfigNode): RawDiff[] {
  const differ = new Differ();
  differ.compare(baseline, current);
  return differ.diffs;
}

import { ProfileRecord, RuleGroup, RuleNode } from '../src/index';

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export interface RefProfile {
  userId: string;
  engagementScore: number | null;
  region: string | null;
  purchaseTags: Set<string>;
}

/** Independent, straightforward per-profile rule evaluation (test oracle). */
export function evalRuleOnProfile(node: RuleNode, profile: RefProfile): boolean {
  switch (node.type) {
    case 'scoreRange':
      return (
        profile.engagementScore !== null &&
        profile.engagementScore >= node.min &&
        profile.engagementScore <= node.max
      );
    case 'region':
      return profile.region === node.value;
    case 'tag':
      return profile.purchaseTags.has(node.value);
    case 'and':
      return node.children.every((child) => evalRuleOnProfile(child, profile));
    case 'or':
      return node.children.some((child) => evalRuleOnProfile(child, profile));
  }
}

export function refCount(rule: RuleGroup, profiles: Iterable<RefProfile>): number {
  let total = 0;
  for (const profile of profiles) {
    if (evalRuleOnProfile(rule, profile)) total++;
  }
  return total;
}

export function refIntersection(
  ruleA: RuleGroup,
  ruleB: RuleGroup,
  profiles: Iterable<RefProfile>,
): number {
  let total = 0;
  for (const profile of profiles) {
    if (evalRuleOnProfile(ruleA, profile) && evalRuleOnProfile(ruleB, profile)) total++;
  }
  return total;
}

export interface RuleGenOptions {
  regions: readonly string[];
  tags: readonly string[];
  maxDepth: number;
  leafBudget: { value: number };
}

/** Generates a random legal rule tree (root group at depth 1). */
export function randomRule(rng: () => number, options: RuleGenOptions): RuleGroup {
  return randomGroup(rng, options, 1);
}

function randomGroup(rng: () => number, options: RuleGenOptions, depth: number): RuleGroup {
  const childCount = 1 + Math.floor(rng() * 3);
  const children: RuleNode[] = [];
  for (let i = 0; i < childCount; i++) {
    const canNest = depth < options.maxDepth && options.leafBudget.value > 2;
    if (canNest && rng() < 0.35) {
      children.push(randomGroup(rng, options, depth + 1));
    } else {
      options.leafBudget.value--;
      children.push(randomLeaf(rng, options));
    }
    if (options.leafBudget.value <= 0) break;
  }
  return { type: rng() < 0.5 ? 'and' : 'or', children };
}

function randomLeaf(rng: () => number, options: RuleGenOptions): RuleNode {
  const kind = Math.floor(rng() * 3);
  if (kind === 0) {
    const a = Math.floor(rng() * 101);
    const b = Math.floor(rng() * 101);
    return { type: 'scoreRange', min: Math.min(a, b), max: Math.max(a, b) };
  }
  if (kind === 1) return { type: 'region', value: pick(rng, options.regions) };
  return { type: 'tag', value: pick(rng, options.tags) };
}

/** Generates a random profile record, exercising nulls and score bounds. */
export function randomRecord(
  rng: () => number,
  userId: string,
  regions: readonly string[],
  tags: readonly string[],
): ProfileRecord {
  const roll = rng();
  const engagementScore =
    roll < 0.15 ? null : roll < 0.25 ? (rng() < 0.5 ? 0 : 100) : Math.floor(rng() * 101);
  const region = rng() < 0.15 ? null : pick(rng, regions);
  const tagCount = Math.floor(rng() * 9);
  const purchaseTags = new Set<string>();
  while (purchaseTags.size < tagCount) purchaseTags.add(pick(rng, tags));
  return { userId, engagementScore, region, purchaseTags };
}

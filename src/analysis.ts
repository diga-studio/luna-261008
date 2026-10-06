import type { ArtifactId, ImpactResult } from './types.js';
import type { TraceGraph } from './graph.js';

class Snapshot implements ImpactResult {
  constructor(private readonly sources: ReadonlyMap<ArtifactId, ReadonlySet<ArtifactId>>) {}

  affectedArtifacts(): ArtifactId[] {
    return [...this.sources.keys()];
  }

  sourcesOf(id: ArtifactId): ReadonlySet<ArtifactId> {
    return this.sources.get(id) ?? new Set();
  }
}

/**
 * 针对一批变更需求做影响分析。
 * 每次调用都基于当前图重新计算，结果快照与后续图变更无关。
 */
export function analyzeImpact(
  graph: TraceGraph,
  changedRequirementIds: ArtifactId[],
): ImpactResult {
  const sources = new Map<ArtifactId, Set<ArtifactId>>();
  const processed = new Set<ArtifactId>();

  for (const origin of changedRequirementIds) {
    if (processed.has(origin)) continue;
    processed.add(origin);

    const artifact = graph.artifactOf(origin);
    if (!artifact) {
      throw new Error(`unknown artifact: ${origin}`);
    }
    if (artifact.type !== 'requirement') {
      throw new Error(`change source must be a requirement: ${origin}`);
    }

    // 从该来源沿有向链接遍历；来源自身也算受影响
    const queue: ArtifactId[] = [origin];
    const visited = new Set<ArtifactId>([origin]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      let entry = sources.get(current);
      if (!entry) {
        entry = new Set();
        sources.set(current, entry);
      }
      entry.add(origin);
      for (const next of graph.successorsOf(current)) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }

  return new Snapshot(sources);
}

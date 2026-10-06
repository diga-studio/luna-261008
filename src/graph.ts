import type { Artifact, TraceLink } from './types.js';

/** 进程内追溯图：持有制品与有向链接 */
export class TraceGraph {
  private artifacts = new Map<string, Artifact['type']>();
  /** from -> to 集合 */
  private adjacency = new Map<string, Set<string>>();

  load(artifacts: readonly Artifact[], links: readonly TraceLink[]): void {
    this.artifacts.clear();
    this.adjacency.clear();
    for (const artifact of artifacts) {
      if (this.artifacts.has(artifact.id)) {
        throw new Error(`duplicate artifact id: ${artifact.id}`);
      }
      this.artifacts.set(artifact.id, artifact.type);
    }
    this.addLinks(links);
  }

  addLinks(links: readonly TraceLink[]): void {
    for (const link of links) {
      this.assertEndpoint(link.from);
      this.assertEndpoint(link.to);
      let targets = this.adjacency.get(link.from);
      if (!targets) {
        targets = new Set();
        this.adjacency.set(link.from, targets);
      }
      targets.add(link.to);
    }
  }

  removeLinks(links: readonly TraceLink[]): void {
    for (const link of links) {
      const targets = this.adjacency.get(link.from);
      if (!targets) continue;
      targets.delete(link.to);
      if (targets.size === 0) {
        this.adjacency.delete(link.from);
      }
    }
  }

  hasArtifact(id: string): boolean {
    return this.artifacts.has(id);
  }

  artifactType(id: string): Artifact['type'] | undefined {
    return this.artifacts.get(id);
  }

  /** 从 id 出发的直达后继 */
  successors(id: string): readonly string[] {
    const targets = this.adjacency.get(id);
    return targets ? [...targets] : [];
  }

  private assertEndpoint(id: string): void {
    if (!this.artifacts.has(id)) {
      throw new Error(`unknown artifact in link: ${id}`);
    }
  }
}

import type { Artifact, ArtifactId, TraceLink } from './types.js';

/** 进程内存中的追溯图 */
export class TraceGraph {
  private artifacts = new Map<ArtifactId, Artifact>();
  private outgoing = new Map<ArtifactId, Set<ArtifactId>>();

  /** 装载一份追溯图，替换当前全部内容 */
  load(artifacts: Artifact[], links: TraceLink[]): void {
    this.artifacts.clear();
    this.outgoing.clear();
    for (const artifact of artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }
    this.addLinks(links);
  }

  /** 批量新增链接，重复链接自动去重 */
  addLinks(links: TraceLink[]): void {
    for (const link of links) {
      this.assertKnown(link.from);
      this.assertKnown(link.to);
      let targets = this.outgoing.get(link.from);
      if (!targets) {
        targets = new Set();
        this.outgoing.set(link.from, targets);
      }
      targets.add(link.to);
    }
  }

  /** 批量删除链接，删除不存在的链接视为无操作 */
  removeLinks(links: TraceLink[]): void {
    for (const link of links) {
      const targets = this.outgoing.get(link.from);
      if (!targets) continue;
      targets.delete(link.to);
      if (targets.size === 0) {
        this.outgoing.delete(link.from);
      }
    }
  }

  hasArtifact(id: ArtifactId): boolean {
    return this.artifacts.has(id);
  }

  artifactOf(id: ArtifactId): Artifact | undefined {
    return this.artifacts.get(id);
  }

  /** 从某制品出发的直接后继 */
  successorsOf(id: ArtifactId): ArtifactId[] {
    return [...(this.outgoing.get(id) ?? [])];
  }

  private assertKnown(id: ArtifactId): void {
    if (!this.artifacts.has(id)) {
      throw new Error(`unknown artifact: ${id}`);
    }
  }
}

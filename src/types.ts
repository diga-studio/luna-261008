/** 制品类型 */
export type ArtifactType = 'requirement' | 'test' | 'design' | 'change-request';

/** 制品标识（稳定 ID） */
export type ArtifactId = string;

/** 制品 */
export interface Artifact {
  id: ArtifactId;
  type: ArtifactType;
}

/** 有向追溯链接：from 变更可能影响 to */
export interface TraceLink {
  from: ArtifactId;
  to: ArtifactId;
}

/** 一次分析的结果快照 */
export interface ImpactResult {
  /** 受影响制品名单（来源集合非空的制品） */
  affectedArtifacts(): ArtifactId[];
  /** 任一制品的完整来源集合；未受影响时返回空集合 */
  sourcesOf(id: ArtifactId): ReadonlySet<ArtifactId>;
}

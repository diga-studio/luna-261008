/** 制品类型 */
export type ArtifactType = 'requirement' | 'test' | 'design-doc' | 'change-request';

/** 制品：以稳定标识区分 */
export interface Artifact {
  id: string;
  type: ArtifactType;
}

/** 有向追溯链接：from 变更可能影响 to */
export interface TraceLink {
  from: string;
  to: string;
}

/** 单个制品的分析结果 */
export interface ArtifactImpact {
  artifactId: string;
  /** 完整来源集合：能到达该制品的本批变更需求 */
  sources: ReadonlySet<string>;
}

/** 一次分析的完整结果 */
export interface AnalysisResult {
  /** 本批变更来源（选定需求） */
  batch: readonly string[];
  /** 受影响制品 -> 来源集合 */
  impacts: ReadonlyMap<string, ReadonlySet<string>>;
}

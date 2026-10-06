import type { AnalysisResult, Artifact, TraceLink } from './types.js';
import { TraceGraph } from './graph.js';
import { analyze } from './analyzer.js';

/** 变更影响追溯库：由上层工程管理工具直接调用，全部状态保存在进程内存 */
export class ImpactTraceLibrary {
  private readonly graph = new TraceGraph();
  private result: AnalysisResult | null = null;

  /** 装载一份追溯图（替换现有内容，并清除旧分析结果） */
  loadGraph(artifacts: readonly Artifact[], links: readonly TraceLink[]): void {
    this.graph.load(artifacts, links);
    this.result = null;
  }

  /** 批量新增链接（使已有分析结果失效） */
  addLinks(links: readonly TraceLink[]): void {
    this.graph.addLinks(links);
    this.result = null;
  }

  /** 批量删除链接（使已有分析结果失效） */
  removeLinks(links: readonly TraceLink[]): void {
    this.graph.removeLinks(links);
    this.result = null;
  }

  /** 针对选定的一批变更需求执行分析，完全基于当前图与当前批次 */
  analyze(sourceRequirementIds: readonly string[]): void {
    this.result = analyze(this.graph, sourceRequirementIds);
  }

  /** 受影响制品名单（来源集合非空的制品） */
  getAffectedArtifacts(): string[] {
    return [...this.currentResult().impacts.keys()];
  }

  /** 任一制品的完整来源集合；未受影响的制品返回空数组 */
  getSourcesOf(artifactId: string): string[] {
    const sources = this.currentResult().impacts.get(artifactId);
    return sources ? [...sources] : [];
  }

  private currentResult(): AnalysisResult {
    if (!this.result) {
      throw new Error('no analysis result: call analyze() first');
    }
    return this.result;
  }
}

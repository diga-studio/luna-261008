import type { AnalysisResult } from './types.js';
import type { TraceGraph } from './graph.js';

/**
 * 针对 选定来源批次执行影响分析。
 * 每个来源沿有向链接可达的制品（含来源自身）都记录该来源；
 * 汇合、交叉、循环均通过按来源的可达遍历自然处理。
 */
export function analyze(graph: TraceGraph, sources: readonly string[]): AnalysisResult {
  const batch = [...new Set(sources)];
  for (const id of batch) {
    const type = graph.artifactType(id);
    if (type === undefined) {
      throw new Error(`unknown source artifact: ${id}`);
    }
    if (type !== 'requirement') {
      throw new Error(`source must be a requirement: ${id} (${type})`);
    }
  }

  const impacts = new Map<string, Set<string>>();
  for (const source of batch) {
    // 从单个来源出发做可达遍历，visited 保证循环与汇合处不重复、不遗漏
    const visited = new Set<string>([source]);
    const queue: string[] = [source];
    while (queue.length > 0) {
      const current = queue.shift()!;
      let targets = impacts.get(current);
      if (!targets) {
        targets = new Set();
        impacts.set(current, targets);
      }
      targets.add(source);
      for (const next of graph.successors(current)) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }

  return { batch, impacts };
}

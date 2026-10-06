// 独立全量计算：与引擎实现不共享任何代码，作为测试对照基准。
import { DIMENSION_WEIGHTS } from '../src/types.js';
import type { Dimension, Probe, Rating, TemplateNode } from '../src/types.js';

const DIMENSIONS: readonly Dimension[] = ['manager', 'peer', 'self'];

export interface Ctx {
  ratings: Map<string, number>; // `${metricId}|${dimension}|${evaluatorId}` -> score
  recused: Set<string>;
}

export function makeCtx(ratings: Rating[], recused: string[]): Ctx {
  const map = new Map<string, number>();
  for (const r of ratings) {
    map.set(`${r.metricId}|${r.dimension}|${r.evaluatorId}`, r.score);
  }
  return { ratings: map, recused: new Set(recused) };
}

const key = (m: string, d: string, e: string): string => `${m}|${d}|${e}`;

function leafValue(
  ctx: Ctx,
  metricId: string,
  min: number,
  max: number,
): { value: number | null; dimStats: Map<Dimension, { sum: number; count: number }> } {
  const dimStats = new Map<Dimension, { sum: number; count: number }>();
  for (const [k, score] of ctx.ratings) {
    const [m, d, e] = k.split('|') as [string, Dimension, string];
    if (m !== metricId || ctx.recused.has(e)) continue;
    const norm = ((score - min) / (max - min)) * 100;
    const stat = dimStats.get(d) ?? { sum: 0, count: 0 };
    stat.sum += norm;
    stat.count += 1;
    dimStats.set(d, stat);
  }
  let weighted = 0;
  let weightSum = 0;
  for (const dim of DIMENSIONS) {
    const stat = dimStats.get(dim);
    if (stat !== undefined && stat.count > 0) {
      weighted += DIMENSION_WEIGHTS[dim] * (stat.sum / stat.count);
      weightSum += DIMENSION_WEIGHTS[dim];
    }
  }
  return { value: weightSum > 0 ? weighted / weightSum : null, dimStats };
}

function nodeValue(ctx: Ctx, node: TemplateNode): number | null {
  if (node.kind === 'leaf') {
    return leafValue(ctx, node.id, node.min, node.max).value;
  }
  let weighted = 0;
  let weightSum = 0;
  for (const child of node.children) {
    const v = nodeValue(ctx, child.node);
    if (v !== null) {
      weighted += child.weight * v;
      weightSum += child.weight;
    }
  }
  return weightSum > 0 ? weighted / weightSum : null;
}

export function oracleRoot(template: TemplateNode, ctx: Ctx): number | null {
  return nodeValue(ctx, template);
}

/** 独立计算 probe 三元组的有效系数 */
export function oracleCoefficient(template: TemplateNode, ctx: Ctx, probe: Probe): number {
  if (ctx.recused.has(probe.evaluatorId)) return 0;
  const raw = ctx.ratings.get(key(probe.metricId, probe.dimension, probe.evaluatorId));
  if (raw === undefined) return 0;

  // 找到从根到该叶子的路径
  const path: { id: string; edgeWeight: number }[] = [];
  const find = (node: TemplateNode, trail: { id: string; edgeWeight: number }[]): boolean => {
    if (node.kind === 'leaf') {
      if (node.id === probe.metricId) {
        path.push(...trail, { id: node.id, edgeWeight: 0 });
        return true;
      }
      return false;
    }
    for (const child of node.children) {
      if (find(child.node, [...trail, { id: node.id, edgeWeight: child.weight }])) {
        return true;
      }
    }
    return false;
  };
  if (!find(template, [])) return 0;

  // 叶子维度因子
  const leafNode = (function locate(node: TemplateNode): TemplateNode | null {
    if (node.kind === 'leaf') return node.id === probe.metricId ? node : null;
    for (const child of node.children) {
      const found = locate(child.node);
      if (found !== null) return found;
    }
    return null;
  })(template);
  if (leafNode === null || leafNode.kind !== 'leaf') return 0;
  const { dimStats } = leafValue(ctx, leafNode.id, leafNode.min, leafNode.max);
  const stat = dimStats.get(probe.dimension);
  if (stat === undefined || stat.count === 0) return 0;
  let presentDimWeight = 0;
  for (const dim of DIMENSIONS) {
    const s = dimStats.get(dim);
    if (s !== undefined && s.count > 0) presentDimWeight += DIMENSION_WEIGHTS[dim];
  }
  let coef = DIMENSION_WEIGHTS[probe.dimension] / presentDimWeight / stat.count;

  // 路径上边权重因子：对每个祖先，子边权重 / 该祖先非缺值子边权重和
  // path 元素：根到叶，edgeWeight 是“父->该元素所代表子节点”的边权重（根元素无意义）
  const byId = new Map<string, TemplateNode>();
  const index = (node: TemplateNode): void => {
    byId.set(node.id, node);
    if (node.kind === 'internal') for (const c of node.children) index(c.node);
  };
  index(template);
  for (let i = 0; i + 1 < path.length; i++) {
    const ancestorEntry = path[i];
    const childEntry = path[i + 1];
    if (ancestorEntry === undefined || childEntry === undefined) return 0;
    const ancestor = byId.get(ancestorEntry.id);
    if (ancestor === undefined || ancestor.kind !== 'internal') return 0;
    let weightSum = 0;
    for (const child of ancestor.children) {
      if (nodeValue(ctx, child.node) !== null) weightSum += child.weight;
    }
    if (weightSum <= 0) return 0;
    coef *= ancestorEntry.edgeWeight / weightSum;
  }
  return coef;
}

/** 收集模板所有叶子 */
export function leavesOf(template: TemplateNode): { id: string; min: number; max: number }[] {
  const out: { id: string; min: number; max: number }[] = [];
  const walk = (node: TemplateNode): void => {
    if (node.kind === 'leaf') {
      out.push({ id: node.id, min: node.min, max: node.max });
    } else {
      for (const c of node.children) walk(c.node);
    }
  };
  walk(template);
  return out;
}

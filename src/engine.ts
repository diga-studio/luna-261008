import { DIMENSION_WEIGHTS } from './types.js';
import type { Dimension, Engine, Probe, Rating, ReadResult, TemplateNode } from './types.js';

const DIMENSIONS: readonly Dimension[] = ['manager', 'peer', 'self'];

interface LeafInfo {
  min: number;
  max: number;
}

interface NodeState {
  id: string;
  parent: NodeState | null;
  /** 父节点指向本节点的边权重（根为 0） */
  edgeWeight: number;
  leaf: LeafInfo | null;
  children: { node: NodeState; weight: number }[];
  /** 当前聚合值；null 表示缺值 */
  value: number | null;
  /** 非缺值直接子节点的边权重之和（内部节点用） */
  presentChildWeight: number;
  /** 叶子用：每个维度未回避有效评分的 sum/count */
  dimSum: Record<Dimension, number>;
  dimCount: Record<Dimension, number>;
  /** 叶子用：存在有效评分的维度权重之和 */
  presentDimWeight: number;
}

function buildState(template: TemplateNode): { root: NodeState; byId: Map<string, NodeState> } {
  const byId = new Map<string, NodeState>();
  const build = (tpl: TemplateNode, parent: NodeState | null, edgeWeight: number): NodeState => {
    if (byId.has(tpl.id)) {
      throw new Error(`duplicate node id: ${tpl.id}`);
    }
    const state: NodeState = {
      id: tpl.id,
      parent,
      edgeWeight,
      leaf: null,
      children: [],
      value: null,
      presentChildWeight: 0,
      dimSum: { manager: 0, peer: 0, self: 0 },
      dimCount: { manager: 0, peer: 0, self: 0 },
      presentDimWeight: 0,
    };
    byId.set(tpl.id, state);
    if (tpl.kind === 'leaf') {
      if (!(tpl.max > tpl.min)) {
        throw new Error(`leaf ${tpl.id}: max must be greater than min`);
      }
      state.leaf = { min: tpl.min, max: tpl.max };
    } else {
      if (tpl.children.length === 0) {
        throw new Error(`internal node ${tpl.id}: must have at least one child`);
      }
      for (const child of tpl.children) {
        if (!(child.weight > 0)) {
          throw new Error(`edge into ${child.node.id}: weight must be positive`);
        }
        const childState = build(child.node, state, child.weight);
        state.children.push({ node: childState, weight: child.weight });
      }
    }
    return state;
  };
  const root = build(template, null, 0);
  return { root, byId };
}

/** 重算叶子聚合值 */
function recomputeLeaf(node: NodeState): void {
  let weighted = 0;
  let weightSum = 0;
  for (const dim of DIMENSIONS) {
    const count = node.dimCount[dim];
    if (count > 0) {
      const w = DIMENSION_WEIGHTS[dim];
      weighted += w * (node.dimSum[dim] / count);
      weightSum += w;
    }
  }
  node.presentDimWeight = weightSum;
  node.value = weightSum > 0 ? weighted / weightSum : null;
}

/** 重算内部节点聚合值 */
function recomputeInternal(node: NodeState): void {
  let weighted = 0;
  let weightSum = 0;
  for (const { node: child, weight } of node.children) {
    if (child.value !== null) {
      weighted += weight * child.value;
      weightSum += weight;
    }
  }
  node.presentChildWeight = weightSum;
  node.value = weightSum > 0 ? weighted / weightSum : null;
}

/** 自叶子向上传播重算 */
function propagate(node: NodeState): void {
  let current: NodeState | null = node;
  while (current !== null) {
    if (current.leaf !== null) {
      recomputeLeaf(current);
    } else {
      recomputeInternal(current);
    }
    current = current.parent;
  }
}

export function createEngine(
  template: TemplateNode,
  ratings: Rating[] = [],
  recusedEvaluators: string[] = [],
): Engine {
  const { root, byId } = buildState(template);
  /** 评分存储：metricId -> dimension -> evaluatorId -> score */
  const store = new Map<string, Map<Dimension, Map<string, number>>>();
  const recused = new Set<string>(recusedEvaluators);

  const leafOf = (metricId: string): NodeState => {
    const node = byId.get(metricId);
    if (node === undefined || node.leaf === null) {
      throw new Error(`unknown leaf metric: ${metricId}`);
    }
    return node;
  };

  const normalize = (leaf: LeafInfo, score: number): number =>
    ((score - leaf.min) / (leaf.max - leaf.min)) * 100;

  /** 调整某叶子某维度的聚合量；delta>0 计入，delta<0 剔除 */
  const applyToLeaf = (
    node: NodeState,
    dimension: Dimension,
    score: number,
    delta: 1 | -1,
  ): void => {
    const leaf = node.leaf;
    if (leaf === null) return;
    node.dimSum[dimension] += delta * normalize(leaf, score);
    node.dimCount[dimension] += delta;
  };

  const applyRating = (
    metricId: string,
    dimension: Dimension,
    evaluatorId: string,
    scoreOrNull: number | null,
  ): void => {
    const node = leafOf(metricId);
    let dimMap = store.get(metricId);
    if (dimMap === undefined) {
      dimMap = new Map();
      store.set(metricId, dimMap);
    }
    let evalMap = dimMap.get(dimension);
    if (evalMap === undefined) {
      evalMap = new Map();
      dimMap.set(dimension, evalMap);
    }
    const previous = evalMap.get(evaluatorId);
    const isRecused = recused.has(evaluatorId);

    if (previous !== undefined && !isRecused) {
      applyToLeaf(node, dimension, previous, -1);
    }
    if (scoreOrNull === null) {
      evalMap.delete(evaluatorId);
    } else {
      if (!Number.isFinite(scoreOrNull)) {
        throw new Error(`score must be a finite number, got: ${scoreOrNull}`);
      }
      evalMap.set(evaluatorId, scoreOrNull);
      if (!isRecused) {
        applyToLeaf(node, dimension, scoreOrNull, 1);
      }
    }
    propagate(node);
  };

  const applyRecused = (evaluatorId: string, isRecused: boolean): void => {
    const wasRecused = recused.has(evaluatorId);
    if (wasRecused === isRecused) return;
    if (isRecused) {
      recused.add(evaluatorId);
    } else {
      recused.delete(evaluatorId);
    }
    const delta = isRecused ? -1 : 1;
    const touched = new Set<NodeState>();
    for (const [metricId, dimMap] of store) {
      const node = byId.get(metricId);
      if (node === undefined) continue;
      for (const [dimension, evalMap] of dimMap) {
        const score = evalMap.get(evaluatorId);
        if (score !== undefined) {
          applyToLeaf(node, dimension, score, delta);
          touched.add(node);
        }
      }
    }
    for (const node of touched) {
      propagate(node);
    }
  };

  // 初始评分逐条载入
  for (const rating of ratings) {
    applyRating(rating.metricId, rating.dimension, rating.evaluatorId, rating.score);
  }

  const coefficientOf = (probe: Probe): number => {
    const node = byId.get(probe.metricId);
    if (node === undefined || node.leaf === null) return 0;
    if (recused.has(probe.evaluatorId)) return 0;
    const score = store.get(probe.metricId)?.get(probe.dimension)?.get(probe.evaluatorId);
    if (score === undefined) return 0;
    // 记录存在且未回避 => 其维度有效 => 叶子非缺值
    const count = node.dimCount[probe.dimension];
    if (count <= 0 || node.presentDimWeight <= 0) return 0;
    let coef = DIMENSION_WEIGHTS[probe.dimension] / node.presentDimWeight / count;
    let current: NodeState = node;
    while (current.parent !== null) {
      const parent: NodeState = current.parent;
      if (parent.presentChildWeight <= 0) return 0;
      coef *= current.edgeWeight / parent.presentChildWeight;
      current = parent;
    }
    return coef;
  };

  return {
    setRating(metricId, dimension, evaluatorId, scoreOrNull) {
      applyRating(metricId, dimension, evaluatorId, scoreOrNull);
    },
    setRecused(evaluatorId, isRecused) {
      applyRecused(evaluatorId, isRecused);
    },
    read(probe?: Probe): ReadResult {
      if (probe === undefined) {
        return { root: root.value };
      }
      return { root: root.value, coefficient: coefficientOf(probe) };
    },
  };
}

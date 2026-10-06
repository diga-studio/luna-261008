import {
  DIMENSION_WEIGHTS,
  Dimension,
  Engine,
  Probe,
  Rating,
  ReadResult,
  TemplateNode,
  isLeaf,
} from './types';

const DIMENSIONS: Dimension[] = ['manager', 'peer', 'self'];

const SEP = '\u0001';

interface LeafState {
  kind: 'leaf';
  id: string;
  min: number;
  max: number;
  parent: InternalState | null;
  /** 每个维度：未回避评价人的归一化分数之和 / 人数 */
  dimSum: Record<Dimension, number>;
  dimCount: Record<Dimension, number>;
  /** 当前叶子聚合值，null 表示缺值 */
  value: number | null;
}

interface InternalState {
  kind: 'internal';
  id: string;
  parent: InternalState | null;
  children: Array<{ node: NodeState; weight: number }>;
  /** 非缺值子节点的边权重之和 */
  activeWeight: number;
  /** 非缺值子节点的 边权重 × 子节点值 之和 */
  valueSum: number;
  value: number | null;
}

type NodeState = LeafState | InternalState;

function ratingKey(metricId: string, dimension: Dimension, evaluatorId: string): string {
  return [metricId, dimension, evaluatorId].join(SEP);
}

export function createEngine(
  template: TemplateNode,
  ratings: Rating[],
  recusedEvaluators: string[],
): Engine {
  // ---- 模板在实例生命周期内固定：构建时一次性编译为内部状态树 ----
  const leaves = new Map<string, LeafState>();
  const recused = new Set<string>(recusedEvaluators);
  /** 全部评分记录（含被回避者的评分）：key -> 原始分数 */
  const records = new Map<string, number>();
  /** 评价人 -> 其评分记录的 key 列表，用于回避切换 */
  const byEvaluator = new Map<string, string[]>();

  function build(node: TemplateNode, parent: InternalState | null): NodeState {
    if (isLeaf(node)) {
      if (!(node.max > node.min)) {
        throw new Error(`leaf "${node.id}": require max > min`);
      }
      if (leaves.has(node.id)) {
        throw new Error(`duplicate node id "${node.id}"`);
      }
      const leaf: LeafState = {
        kind: 'leaf',
        id: node.id,
        min: node.min,
        max: node.max,
        parent,
        dimSum: { manager: 0, peer: 0, self: 0 },
        dimCount: { manager: 0, peer: 0, self: 0 },
        value: null,
      };
      leaves.set(node.id, leaf);
      return leaf;
    }
    const internal: InternalState = {
      kind: 'internal',
      id: node.id,
      parent,
      children: [],
      activeWeight: 0,
      valueSum: 0,
      value: null,
    };
    if (node.children.length === 0) {
      throw new Error(`internal node "${node.id}": require at least one child`);
    }
    for (const { node: child, weight } of node.children) {
      if (!(weight > 0)) {
        throw new Error(`edge into "${child.id}": weight must be positive`);
      }
      internal.children.push({ node: build(child, internal), weight });
    }
    return internal;
  }

  const root = build(template, null);

  function normalize(leaf: LeafState, raw: number): number {
    return ((raw - leaf.min) / (leaf.max - leaf.min)) * 100;
  }

  function recomputeLeaf(leaf: LeafState): void {
    let weightSum = 0;
    let acc = 0;
    for (const dim of DIMENSIONS) {
      const count = leaf.dimCount[dim];
      if (count > 0) {
        const w = DIMENSION_WEIGHTS[dim];
        weightSum += w;
        acc += w * (leaf.dimSum[dim] / count);
      }
    }
    leaf.value = weightSum > 0 ? acc / weightSum : null;
  }

  /**
   * 子节点值变化后，自底向上刷新内部节点聚合。
   * oldLeafValue 是叶子在本次变更前的值（父聚合中仍挂着旧贡献）。
   */
  function propagateFrom(leaf: LeafState, oldLeafValue: number | null): void {
    let child: NodeState = leaf;
    let oldChildValue = oldLeafValue;
    let parent = leaf.parent;
    while (parent !== null) {
      const edge = parent.children.find((c) => c.node === child);
      if (edge === undefined) {
        throw new Error('corrupt tree: parent edge not found');
      }
      const oldParentValue = parent.value;
      // 先按旧值把该子节点从父聚合中移除，再按新值加回
      if (oldChildValue !== null) {
        parent.activeWeight -= edge.weight;
        parent.valueSum -= edge.weight * oldChildValue;
      }
      if (child.value !== null) {
        parent.activeWeight += edge.weight;
        parent.valueSum += edge.weight * child.value;
      }
      parent.value = parent.activeWeight > 0 ? parent.valueSum / parent.activeWeight : null;
      child = parent;
      oldChildValue = oldParentValue;
      parent = parent.parent;
    }
  }

  /** 向叶子维度聚合中加入/移除一条评分（仅当评价人未回避时才调用） */
  function applyToLeaf(metricId: string, dimension: Dimension, raw: number, sign: 1 | -1): LeafState {
    const leaf = leaves.get(metricId);
    if (leaf === undefined) {
      throw new Error(`unknown metric id "${metricId}"`);
    }
    leaf.dimSum[dimension] += sign * normalize(leaf, raw);
    leaf.dimCount[dimension] += sign;
    recomputeLeaf(leaf);
    return leaf;
  }

  // ---- 初始评分 ----
  for (const r of ratings) {
    const key = ratingKey(r.metricId, r.dimension, r.evaluatorId);
    records.set(key, r.score);
    let list = byEvaluator.get(r.evaluatorId);
    if (list === undefined) {
      list = [];
      byEvaluator.set(r.evaluatorId, list);
    }
    list.push(key);
    if (!recused.has(r.evaluatorId)) {
      applyToLeaf(r.metricId, r.dimension, r.score, 1);
    }
  }
  for (const leaf of leaves.values()) {
    if (leaf.value !== null) {
      propagateFrom(leaf, null);
    }
  }

  function setRating(
    metricId: string,
    dimension: Dimension,
    evaluatorId: string,
    scoreOrNull: number | null,
  ): void {
    if (!leaves.has(metricId)) {
      throw new Error(`unknown metric id "${metricId}"`);
    }
    const key = ratingKey(metricId, dimension, evaluatorId);
    const old = records.get(key);
    const active = !recused.has(evaluatorId);
    const leafState = leaves.get(metricId) as LeafState;
    const oldLeafValue = leafState.value;
    let leaf: LeafState | null = null;
    if (old !== undefined) {
      if (active) {
        leaf = applyToLeaf(metricId, dimension, old, -1);
      }
      records.delete(key);
      const list = byEvaluator.get(evaluatorId);
      if (list !== undefined) {
        const idx = list.indexOf(key);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
    }
    if (scoreOrNull !== null) {
      records.set(key, scoreOrNull);
      let list = byEvaluator.get(evaluatorId);
      if (list === undefined) {
        list = [];
        byEvaluator.set(evaluatorId, list);
      }
      list.push(key);
      if (active) {
        leaf = applyToLeaf(metricId, dimension, scoreOrNull, 1);
      }
    }
    if (leaf !== null) {
      propagateFrom(leaf, oldLeafValue);
    }
  }

  function setRecused(evaluatorId: string, isRecused: boolean): void {
    const wasRecused = recused.has(evaluatorId);
    if (wasRecused === isRecused) {
      return; // 重复设置不得改变结果
    }
    if (isRecused) {
      recused.add(evaluatorId);
    } else {
      recused.delete(evaluatorId);
    }
    const sign: 1 | -1 = isRecused ? -1 : 1;
    const oldValues = new Map<LeafState, number | null>();
    const keys = byEvaluator.get(evaluatorId) ?? [];
    for (const key of keys) {
      const metricId = key.split(SEP)[0] as string;
      const leaf = leaves.get(metricId);
      if (leaf !== undefined && !oldValues.has(leaf)) {
        oldValues.set(leaf, leaf.value);
      }
    }
    for (const key of keys) {
      const parts = key.split(SEP);
      const metricId = parts[0] as string;
      const dimension = parts[1] as Dimension;
      const raw = records.get(key);
      if (raw === undefined) {
        continue;
      }
      applyToLeaf(metricId, dimension, raw, sign);
    }
    for (const [leaf, oldValue] of oldValues) {
      propagateFrom(leaf, oldValue);
    }
  }

  function read(probe?: Probe): ReadResult {
    const result: ReadResult = { rootScore: root.value };
    if (probe !== undefined) {
      result.coefficient = coefficientOf(probe);
    }
    return result;
  }

  /** 该记录归一化分数在当前聚合表达式中所乘的因子 */
  function coefficientOf(probe: Probe): number {
    const key = ratingKey(probe.metricId, probe.dimension, probe.evaluatorId);
    if (!records.has(key) || recused.has(probe.evaluatorId)) {
      return 0;
    }
    const leaf = leaves.get(probe.metricId);
    if (leaf === undefined || leaf.value === null) {
      return 0;
    }
    // 叶子内：维度权重归一化 × 维度内等权
    let presentWeight = 0;
    for (const dim of DIMENSIONS) {
      if (leaf.dimCount[dim] > 0) {
        presentWeight += DIMENSION_WEIGHTS[dim];
      }
    }
    const count = leaf.dimCount[probe.dimension];
    if (count === 0) {
      return 0;
    }
    let coef = DIMENSION_WEIGHTS[probe.dimension] / presentWeight / count;
    // 沿祖先链：每层的边权重按非缺值兄弟重新归一化
    let child: NodeState = leaf;
    let parent = leaf.parent;
    while (parent !== null) {
      const edge = parent.children.find((c) => c.node === child);
      if (edge === undefined || parent.activeWeight === 0) {
        return 0;
      }
      coef *= edge.weight / parent.activeWeight;
      child = parent;
      parent = parent.parent;
    }
    return coef;
  }

  return { setRating, setRecused, read };
}

'use strict';
// 独立的全量参考实现：不做任何增量，每次从原始记录整体重算。

const DIMENSION_WEIGHTS = { manager: 50, peer: 30, self: 20 };
const DIMENSIONS = ['manager', 'peer', 'self'];

function key(metricId, dimension, evaluatorId) {
  return metricId + '|' + dimension + '|' + evaluatorId;
}

/** 可复现的伪随机数发生器 (mulberry32) */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 全量重算。
 * @param template 模板树
 * @param records Map: key(metricId,dim,evaluator) -> 原始分数
 * @param recused Set<evaluatorId>
 * @returns {{ rootScore: number|null, coefficient: (m,d,e)=>number }}
 */
function fullCompute(template, records, recused) {
  const leaves = new Map();
  const parentOf = new Map(); // nodeId -> { parent, edgeWeight }
  (function index(node, parent, edgeWeight) {
    if (!('children' in node)) {
      leaves.set(node.id, node);
    } else {
      for (const c of node.children) index(c.node, node, c.weight);
    }
    if (parent) parentOf.set(node.id, { parent, edgeWeight });
  })(template, null, 0);

  // 叶子聚合
  const leafValue = new Map();
  const leafDimStats = new Map(); // metricId -> { dim -> {sum, count} }
  for (const [id, leaf] of leaves) {
    const stats = {};
    for (const d of DIMENSIONS) stats[d] = { sum: 0, count: 0 };
    leafDimStats.set(id, stats);
    void leaf;
  }
  for (const [k, raw] of records) {
    const [metricId, dim, ev] = k.split('|');
    if (recused.has(ev)) continue;
    const leaf = leaves.get(metricId);
    const norm = ((raw - leaf.min) / (leaf.max - leaf.min)) * 100;
    const st = leafDimStats.get(metricId)[dim];
    st.sum += norm;
    st.count += 1;
  }
  for (const [id] of leaves) {
    const stats = leafDimStats.get(id);
    let wSum = 0, acc = 0;
    for (const d of DIMENSIONS) {
      if (stats[d].count > 0) {
        wSum += DIMENSION_WEIGHTS[d];
        acc += DIMENSION_WEIGHTS[d] * (stats[d].sum / stats[d].count);
      }
    }
    leafValue.set(id, wSum > 0 ? acc / wSum : null);
  }

  // 内部节点自底向上
  const nodeValue = new Map();
  for (const [id, v] of leafValue) nodeValue.set(id, v);
  (function evalNode(node) {
    if (!('children' in node)) return nodeValue.get(node.id);
    let wSum = 0, acc = 0;
    for (const c of node.children) {
      const v = evalNode(c.node);
      if (v !== null) {
        wSum += c.weight;
        acc += c.weight * v;
      }
    }
    const v = wSum > 0 ? acc / wSum : null;
    nodeValue.set(node.id, v);
    return v;
  })(template);

  function coefficient(metricId, dim, ev) {
    if (!records.has(key(metricId, dim, ev))) return 0;
    if (recused.has(ev)) return 0;
    const stats = leafDimStats.get(metricId);
    if (stats === undefined) return 0;
    if (nodeValue.get(metricId) === null) return 0;
    let wSum = 0;
    for (const d of DIMENSIONS) {
      if (stats[d].count > 0) wSum += DIMENSION_WEIGHTS[d];
    }
    if (stats[dim].count === 0) return 0;
    let coef = DIMENSION_WEIGHTS[dim] / wSum / stats[dim].count;
    // 沿祖先链乘上边权重归一化因子
    let cur = metricId;
    while (parentOf.has(cur)) {
      const { parent, edgeWeight } = parentOf.get(cur);
      let activeW = 0;
      for (const c of parent.children) {
        if (nodeValue.get(c.node.id) !== null) activeW += c.weight;
      }
      if (activeW === 0) return 0;
      coef *= edgeWeight / activeW;
      cur = parent.id;
    }
    return coef;
  }

  return { rootScore: nodeValue.get(template.id), coefficient, nodeValue, leaves };
}

/** 生成随机小树：混合量程、不同深度 */
function randomTemplate(rng) {
  let counter = 0;
  const ranges = [
    [0, 5], [1, 7], [0, 100], [-10, 10], [0, 1], [20, 80],
  ];
  function gen(depth) {
    const id = 'n' + counter++;
    if (depth === 0 || rng() < 0.4) {
      const [min, max] = ranges[Math.floor(rng() * ranges.length)];
      return { id, min, max };
    }
    const n = 1 + Math.floor(rng() * 3);
    const children = [];
    for (let i = 0; i < n; i++) {
      children.push({ node: gen(depth - 1), weight: 0.5 + rng() * 3 });
    }
    return { id, children };
  }
  return gen(3);
}

function collectLeaves(node, out = []) {
  if (!('children' in node)) out.push(node);
  else for (const c of node.children) collectLeaves(c.node, out);
  return out;
}

function approxEqual(a, b, eps = 1e-9) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

module.exports = {
  DIMENSION_WEIGHTS,
  DIMENSIONS,
  key,
  makeRng,
  fullCompute,
  randomTemplate,
  collectLeaves,
  approxEqual,
};

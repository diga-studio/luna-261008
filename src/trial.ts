import type { BomArchive, Revision } from './archive.js';
import {
  SCALE,
  ceilToInteger,
  integerToText,
  multiplyLine,
  parseInteger,
} from './decimal.js';
import {
  TrialError,
  type ConsumptionEntry,
  type ProductionEntry,
  type TrialInput,
  type TrialResult,
} from './types.js';

/** 最大展开层数（根件为第 1 层） */
export const MAX_LEVEL = 12;

const MAX_ROOT_QUANTITY = 1_000_000_000_000n;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 展开节点：普通自制件或幻影件，按 物料+修订 区分 */
interface Node {
  key: string;
  materialId: string;
  revision: Revision;
  phantom: boolean;
  /** 解析后的明细：childKey 为 null 表示外购件 */
  resolved: Array<{ usageScaled: bigint; lossFactor: bigint; childKey: string | null; componentId: string }>;
  /** 子节点 key 列表（用于拓扑与环检测） */
  childKeys: string[];
  /** 最长路径层级（根件为 1） */
  level: number;
  /** 精确需求（定点） */
  demand: bigint;
}

/**
 * 执行一次多级 BOM 需求试算。
 * 失败时抛出 TrialError，不返回部分结果。
 */
export function runTrial(archive: BomArchive, input: TrialInput): TrialResult {
  if (!DATE_RE.test(input.productionDate)) {
    throw new TrialError('INVALID_INPUT', '生产日期不合法: ' + JSON.stringify(input.productionDate));
  }
  const date = input.productionDate;

  const nodes = new Map<string, Node>();
  const rootKeys: string[] = [];

  const getOrCreateNode = (materialId: string, revision: Revision, phantom: boolean): Node => {
    const key = materialId + ' ' + revision.revisionId;
    let node = nodes.get(key);
    if (node === undefined) {
      node = { key, materialId, revision, phantom, resolved: [], childKeys: [], level: 0, demand: 0n };
      nodes.set(key, node);
    }
    return node;
  };

  // 校验根件并作为结构发现起点
  const rootQuantities: Array<{ key: string; qty: bigint }> = [];
  for (const root of input.roots) {
    const type = archive.materialType(root.materialId);
    if (type === undefined) {
      throw new TrialError('INVALID_INPUT', '根件物料未定义: ' + root.materialId);
    }
    if (type !== 'manufactured') {
      throw new TrialError('INVALID_INPUT', '根件必须是普通自制件: ' + root.materialId);
    }
    const revision = archive.revisionById(root.revisionId);
    if (revision === undefined || revision.materialId !== root.materialId) {
      throw new TrialError(
        'INVALID_INPUT',
        '根件 ' + root.materialId + ' 指定的修订不存在: ' + root.revisionId,
      );
    }
    const qty = parseInteger(root.quantity);
    if (qty > MAX_ROOT_QUANTITY * SCALE) {
      throw new TrialError('INVALID_INPUT', '根件需求超过上限 1000000000000: ' + root.materialId);
    }
    const node = getOrCreateNode(root.materialId, revision, false);
    rootKeys.push(node.key);
    rootQuantities.push({ key: node.key, qty });
  }

  // 阶段一：结构发现。沿本次实际使用的修订做 BFS，解析每条明细的组件节点。
  const queue: Node[] = [...nodes.values()];
  const enqueued = new Set<string>([...nodes.keys()]);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const line of node.revision.lines) {
      const childType = archive.materialType(line.componentId);
      if (childType === undefined) {
        throw new TrialError('INVALID_INPUT', '组件物料未定义: ' + line.componentId);
      }
      if (childType === 'purchased') {
        node.resolved.push({
          usageScaled: line.usageScaled,
          lossFactor: line.lossFactor,
          childKey: null,
          componentId: line.componentId,
        });
        continue;
      }
      const childRevision = archive.effectiveRevision(line.componentId, date);
      if (childRevision === undefined) {
        throw new TrialError(
          'NO_VALID_REVISION',
          '物料 ' + line.componentId + ' 在生产日期 ' + date + ' 没有有效修订',
        );
      }
      const child = getOrCreateNode(line.componentId, childRevision, childType === 'phantom');
      if (!enqueued.has(child.key)) {
        enqueued.add(child.key);
        queue.push(child);
      }
      node.resolved.push({
        usageScaled: line.usageScaled,
        lossFactor: line.lossFactor,
        childKey: child.key,
        componentId: line.componentId,
      });
      node.childKeys.push(child.key);
    }
  }

  // 阶段二：Kahn 拓扑排序。剩余未处理节点说明有效路径存在循环。
  const indegree = new Map<string, number>();
  for (const node of nodes.values()) {
    indegree.set(node.key, 0);
  }
  for (const node of nodes.values()) {
    for (const childKey of node.childKeys) {
      indegree.set(childKey, (indegree.get(childKey) ?? 0) + 1);
    }
  }
  const topo: Node[] = [];
  const ready: Node[] = [];
  for (const key of rootKeys) {
    const node = nodes.get(key)!;
    if (node.level === 0) {
      node.level = 1;
    }
  }
  for (const node of nodes.values()) {
    if (indegree.get(node.key) === 0) {
      ready.push(node);
      if (node.level === 0) {
        node.level = 1;
      }
    }
  }
  for (let head = 0; head < ready.length; head++) {
    const node = ready[head]!;
    topo.push(node);
    for (const childKey of node.childKeys) {
      const child = nodes.get(childKey)!;
      if (node.level + 1 > child.level) {
        child.level = node.level + 1;
      }
      const remaining = indegree.get(childKey)! - 1;
      indegree.set(childKey, remaining);
      if (remaining === 0) {
        ready.push(child);
      }
    }
  }
  if (topo.length < nodes.size) {
    const processed = new Set<string>(topo.map((n) => n.key));
    const leftover = [...nodes.values()].find((n) => !processed.has(n.key));
    throw new TrialError('CYCLE', '展开路径存在循环，涉及物料 ' + (leftover?.materialId ?? ''));
  }
  for (const node of topo) {
    if (node.level > MAX_LEVEL || (node.level === MAX_LEVEL && node.revision.lines.length > 0)) {
      throw new TrialError(
        'MAX_DEPTH',
        '展开路径超过 ' + MAX_LEVEL + ' 层（物料 ' + node.materialId + ' 位于第 ' + node.level + ' 层）',
      );
    }
  }

  // 阶段三：按拓扑序合并需求并展开。普通自制件合并后取整，幻影件精确传递。
  const production = new Map<string, { node: Node; qty: bigint }>();
  const consumption = new Map<string, bigint>();
  for (const { key, qty } of rootQuantities) {
    const node = nodes.get(key)!;
    node.demand += qty;
  }
  for (const node of topo) {
    if (node.demand === 0n) {
      continue;
    }
    let expandQty: bigint;
    if (node.phantom) {
      expandQty = node.demand;
    } else {
      const units = ceilToInteger(node.demand);
      production.set(node.key, { node, qty: node.demand });
      expandQty = units * SCALE;
    }
    for (const line of node.resolved) {
      const childQty = multiplyLine(expandQty, line.usageScaled, line.lossFactor);
      if (childQty === 0n) {
        continue;
      }
      if (line.childKey === null) {
        consumption.set(line.componentId, (consumption.get(line.componentId) ?? 0n) + childQty);
      } else {
        nodes.get(line.childKey)!.demand += childQty;
      }
    }
  }

  const productionOut: ProductionEntry[] = [...production.values()]
    .map(({ node, qty }) => ({
      materialId: node.materialId,
      revisionId: node.revision.revisionId,
      quantity: integerToText(ceilToInteger(qty)),
    }))
    .sort((a, b) =>
      a.materialId === b.materialId
        ? a.revisionId < b.revisionId
          ? -1
          : 1
        : a.materialId < b.materialId
          ? -1
          : 1,
    );

  const consumptionOut: ConsumptionEntry[] = [...consumption.entries()]
    .map(([materialId, qty]) => ({
      materialId,
      quantity: integerToText(ceilToInteger(qty)),
    }))
    .sort((a, b) => (a.materialId < b.materialId ? -1 : 1));

  return { production: productionOut, consumption: consumptionOut };
}

import { BomArchive } from './archive.js';
import {
  Decimal,
  addDecimal,
  ceilDecimal,
  decimalFromBigint,
  multiplyDecimal,
  parseInteger,
  bigintToText,
} from './decimal.js';
import {
  MaterialType,
  TrialError,
  TrialInput,
  TrialResult,
  ProductionQuantity,
  IssueQuantity,
} from './types.js';

const MAX_LEVEL = 12;
const MAX_ROOT_QUANTITY = 1000000000000n;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Edge {
  readonly childKey: string;
  readonly usage: Decimal;
  readonly lossFactor: Decimal;
}

interface Node {
  readonly key: string;
  readonly materialId: string;
  readonly revisionId: string | null;
  readonly type: MaterialType;
  readonly edges: Edge[];
  demand: Decimal;
  indegree: number;
  /** 最长路径层级（根=1），拓扑传播时取所有父节点层级+1 的最大值 */
  level: number;
  /** 子树高度（含自身，沿有效图到叶子的最长链） */
  height: number;
  state: 0 | 1 | 2; // 0=未访问 1=访问中 2=已完成
}

function purchasedKey(materialId: string): string {
  return JSON.stringify(['P', materialId]);
}

function expandKey(materialId: string, revisionId: string): string {
  return JSON.stringify(['E', materialId, revisionId]);
}

class TrialContext {
  readonly nodes = new Map<string, Node>();

  constructor(
    private readonly archive: BomArchive,
    private readonly date: string,
  ) {}

  getOrCreatePurchased(materialId: string): Node {
    const key = purchasedKey(materialId);
    let node = this.nodes.get(key);
    if (node === undefined) {
      node = {
        key,
        materialId,
        revisionId: null,
        type: 'PURCHASED',
        edges: [],
        demand: decimalFromBigint(0n),
        indegree: 0,
        level: 0,
        height: 1,
        state: 0,
      };
      this.nodes.set(key, node);
    }
    return node;
  }

  getOrCreateExpandable(materialId: string, revisionId: string, type: MaterialType): Node {
    const key = expandKey(materialId, revisionId);
    let node = this.nodes.get(key);
    if (node === undefined) {
      node = {
        key,
        materialId,
        revisionId,
        type,
        edges: [],
        demand: decimalFromBigint(0n),
        indegree: 0,
        level: 0,
        height: 1,
        state: 0,
      };
      this.nodes.set(key, node);
    }
    return node;
  }

  /** 发现可达有效图：解析子件修订、建边，检测循环与超深。 */
  discover(node: Node, depth: number): void {
    if (node.state === 2) {
      return;
    }
    if (node.state === 1) {
      throw new TrialError(
        'CYCLE_DETECTED',
        `cycle detected at material ${node.materialId} (revision ${node.revisionId ?? '-'})`,
      );
    }
    node.state = 1;
    if (node.type !== 'PURCHASED') {
      const revision = this.archive.revision(node.revisionId!);
      if (revision === undefined) {
        throw new TrialError('UNKNOWN_REVISION', `unknown revision: ${node.revisionId}`);
      }
      for (const line of revision.lines) {
        if (depth + 1 > MAX_LEVEL) {
          throw new TrialError(
            'DEPTH_EXCEEDED',
            `expansion path exceeds ${MAX_LEVEL} levels at material ${line.componentId}`,
          );
        }
        const childType = this.archive.materialType(line.componentId);
        if (childType === undefined) {
          throw new TrialError('UNKNOWN_MATERIAL', `unknown component material: ${line.componentId}`);
        }
        let child: Node;
        if (childType === 'PURCHASED') {
          child = this.getOrCreatePurchased(line.componentId);
        } else {
          const effective = this.archive.effectiveRevision(line.componentId, this.date);
          if (effective === undefined) {
            throw new TrialError(
              'NO_EFFECTIVE_REVISION',
              `no effective revision for material ${line.componentId} on ${this.date}`,
            );
          }
          child = this.getOrCreateExpandable(line.componentId, effective.id, childType);
        }
        node.edges.push({ childKey: child.key, usage: line.usage, lossFactor: line.lossFactor });
        child.indegree += 1;
        this.discover(child, depth + 1);
        if (child.height + 1 > node.height) {
          node.height = child.height + 1;
        }
      }
    }
    node.state = 2;
  }
}

/** 执行一次试算。失败时抛 TrialError，不返回部分结果。 */
export function runTrial(archive: BomArchive, input: TrialInput): TrialResult {
  if (!DATE_RE.test(input.productionDate)) {
    throw new TrialError('INVALID_INPUT', `invalid production date: ${JSON.stringify(input.productionDate)}`);
  }

  const ctx = new TrialContext(archive, input.productionDate);

  // 根件：校验、合并相同物料+修订的需求、建节点
  const rootDemand = new Map<string, { materialId: string; revisionId: string; qty: bigint }>();
  for (const root of input.roots) {
    const type = archive.materialType(root.materialId);
    if (type === undefined) {
      throw new TrialError('UNKNOWN_MATERIAL', `unknown root material: ${root.materialId}`);
    }
    if (type !== 'MANUFACTURED') {
      throw new TrialError('ROOT_NOT_MANUFACTURED', `root material ${root.materialId} is not a manufactured part`);
    }
    const revision = archive.revision(root.revisionId);
    if (revision === undefined) {
      throw new TrialError('UNKNOWN_REVISION', `unknown root revision: ${root.revisionId}`);
    }
    if (revision.materialId !== root.materialId) {
      throw new TrialError(
        'REVISION_MATERIAL_MISMATCH',
        `revision ${root.revisionId} does not belong to material ${root.materialId}`,
      );
    }
    let qty: bigint;
    try {
      qty = parseInteger(root.quantity, `root quantity of ${root.materialId}`);
    } catch (e) {
      throw new TrialError('INVALID_INPUT', (e as Error).message);
    }
    if (qty <= 0n || qty > MAX_ROOT_QUANTITY) {
      throw new TrialError(
        'INVALID_INPUT',
        `root quantity out of range 1..1000000000000 for ${root.materialId}: ${root.quantity}`,
      );
    }
    const key = expandKey(root.materialId, root.revisionId);
    const prev = rootDemand.get(key);
    if (prev === undefined) {
      rootDemand.set(key, { materialId: root.materialId, revisionId: root.revisionId, qty });
    } else {
      prev.qty += qty;
    }
  }

  const queue: Node[] = [];
  for (const { materialId, revisionId, qty } of rootDemand.values()) {
    const node = ctx.getOrCreateExpandable(materialId, revisionId, 'MANUFACTURED');
    node.demand = decimalFromBigint(qty);
    node.level = 1;
    ctx.discover(node, 1);
  }

  // Kahn 拓扑传播：入度归零时该节点需求已聚合完毕
  for (const node of ctx.nodes.values()) {
    if (node.indegree === 0) {
      checkDepth(node);
      queue.push(node);
    }
  }

  const production: ProductionQuantity[] = [];
  const issue: IssueQuantity[] = [];

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    let expand: Decimal;
    if (node.type === 'MANUFACTURED') {
      const qty = ceilDecimal(node.demand);
      production.push({ materialId: node.materialId, revisionId: node.revisionId!, quantity: bigintToText(qty) });
      expand = decimalFromBigint(qty);
    } else if (node.type === 'PHANTOM') {
      expand = node.demand;
    } else {
      issue.push({ materialId: node.materialId, quantity: bigintToText(ceilDecimal(node.demand)) });
      continue;
    }
    for (const edge of node.edges) {
      const child = ctx.nodes.get(edge.childKey)!;
      const add = multiplyDecimal(multiplyDecimal(expand, edge.usage), edge.lossFactor);
      child.demand = addDecimal(child.demand, add);
      if (node.level + 1 > child.level) {
        child.level = node.level + 1;
      }
      child.indegree -= 1;
      if (child.indegree === 0) {
        checkDepth(child);
        queue.push(child);
      }
    }
  }

  production.sort((a, b) =>
    a.materialId === b.materialId
      ? a.revisionId < b.revisionId
        ? -1
        : a.revisionId > b.revisionId
          ? 1
          : 0
      : a.materialId < b.materialId
        ? -1
        : 1,
  );
  issue.sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0));

  return { production, issue };
}

/** 任一展开路径最多 12 层：节点最长路径层级 + 其子树高度 - 1 超过 12 即失败。 */
function checkDepth(node: { level: number; height: number; materialId: string }): void {
  if (node.level + node.height - 1 > MAX_LEVEL) {
    throw new TrialError(
      'DEPTH_EXCEEDED',
      `expansion path exceeds ${MAX_LEVEL} levels at material ${node.materialId}`,
    );
  }
}

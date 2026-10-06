import { MinCostFlow } from './mincostflow.js';
import { splitBranchQuotas } from './quota.js';
import type {
  AllocationRequest,
  AllocationResult,
  CombinationAllocation,
} from './types.js';

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer, got ${String(value)}`);
  }
}

function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

interface ValidatedGroup {
  groupId: string;
  demand: number;
  quotas: Map<number, number>;
}

function validateRequest(request: AllocationRequest): {
  materials: Map<string, number>;
  groups: ValidatedGroup[];
  combinationProfit: Map<string, number>;
} {
  const materials = new Map<string, number>();
  for (const material of request.materials) {
    assertNonEmptyString(material.materialId, 'material.materialId');
    assertSafeInteger(material.capacity, `material ${material.materialId} capacity`);
    if (material.capacity < 0) {
      throw new RangeError(`material ${material.materialId} capacity must be non-negative`);
    }
    if (materials.has(material.materialId)) {
      throw new TypeError(`duplicate materialId: ${material.materialId}`);
    }
    materials.set(material.materialId, material.capacity);
  }

  const groups: ValidatedGroup[] = [];
  const groupIds = new Set<string>();
  for (const group of request.groups) {
    assertNonEmptyString(group.groupId, 'group.groupId');
    assertNonEmptyString(group.regionCode, `group ${group.groupId} regionCode`);
    assertNonEmptyString(group.segmentId, `group ${group.groupId} segmentId`);
    assertSafeInteger(group.demand, `group ${group.groupId} demand`);
    if (group.demand < 0) {
      throw new RangeError(`group ${group.groupId} demand must be non-negative`);
    }
    if (groupIds.has(group.groupId)) {
      throw new TypeError(`duplicate groupId: ${group.groupId}`);
    }
    groupIds.add(group.groupId);

    if (!Array.isArray(group.branches) || group.branches.length < 2 || group.branches.length > 5) {
      throw new RangeError(`group ${group.groupId} must have 2 to 5 branches`);
    }
    const branchIds = new Set<number>();
    let percentSum = 0;
    for (const branch of group.branches) {
      assertSafeInteger(branch.branchId, `group ${group.groupId} branchId`);
      assertSafeInteger(branch.percent, `group ${group.groupId} branch ${branch.branchId} percent`);
      if (branch.branchId <= 0) {
        throw new RangeError(`group ${group.groupId} branchId must be positive`);
      }
      if (branch.percent <= 0) {
        throw new RangeError(`group ${group.groupId} branch ${branch.branchId} percent must be positive`);
      }
      if (branchIds.has(branch.branchId)) {
        throw new TypeError(`group ${group.groupId} duplicate branchId: ${branch.branchId}`);
      }
      branchIds.add(branch.branchId);
      percentSum += branch.percent;
    }
    if (percentSum !== 100) {
      throw new RangeError(`group ${group.groupId} branch percents must sum to 100, got ${percentSum}`);
    }

    groups.push({
      groupId: group.groupId,
      demand: group.demand,
      quotas: splitBranchQuotas(group.demand, group.branches),
    });
  }

  const groupById = new Map<string, ValidatedGroup>();
  for (const group of groups) {
    groupById.set(group.groupId, group);
  }

  const combinationProfit = new Map<string, number>();
  for (const combo of request.combinations) {
    assertSafeInteger(combo.profit, 'combination profit');
    if (!materials.has(combo.materialId)) {
      throw new TypeError(`combination references unknown materialId: ${combo.materialId}`);
    }
    if (!groupIds.has(combo.groupId)) {
      throw new TypeError(`combination references unknown groupId: ${combo.groupId}`);
    }
    const group = groupById.get(combo.groupId) as ValidatedGroup;
    if (!group.quotas.has(combo.branchId)) {
      throw new TypeError(
        `combination references unknown branchId ${combo.branchId} for group ${combo.groupId}`,
      );
    }
    const key = `${combo.materialId} ${combo.groupId} ${combo.branchId}`;
    const existing = combinationProfit.get(key);
    if (existing === undefined || combo.profit > existing) {
      combinationProfit.set(key, combo.profit);
    }
  }

  return { materials, groups, combinationProfit };
}

/**
 * 生成满足全部分支额度与素材上限、总收益最高的分配方案。
 * 无法满足全部额度时返回 { ok: false, reason: 'infeasible' }。
 * 结果中只包含曝光量大于 0 的组合。
 */
export function solveAllocation(request: AllocationRequest): AllocationResult {
  const { materials, groups, combinationProfit } = validateRequest(request);

  const activeGroups = groups.filter((group) => group.demand > 0);
  let totalDemand = 0;
  for (const group of activeGroups) totalDemand += group.demand;

  if (totalDemand === 0) {
    return { ok: true, allocations: [], totalProfit: 0n };
  }

  const materialIds = [...materials.keys()];
  const materialNode = new Map<string, number>();
  materialIds.forEach((id, index) => materialNode.set(id, 1 + index));

  const branchNode = new Map<string, number>();
  let nextNode = 1 + materialIds.length;
  for (const group of activeGroups) {
    for (const [branchId, quota] of group.quotas) {
      if (quota > 0) {
        branchNode.set(`${group.groupId}${branchId}`, nextNode);
        nextNode += 1;
      }
    }
  }
  const source = 0;
  const sink = nextNode;

  const flow = new MinCostFlow(sink + 1);

  for (const [materialId, node] of materialNode) {
    flow.addEdge(source, node, materials.get(materialId) as number, 0);
  }

  interface ComboEdge {
    materialId: string;
    groupId: string;
    branchId: number;
    from: number;
    edgeIndex: number;
  }
  const comboEdges: ComboEdge[] = [];
  for (const combo of request.combinations) {
    const key = `${combo.materialId} ${combo.groupId} ${combo.branchId}`;
    if (combinationProfit.get(key) !== combo.profit) continue;
    const branch = branchNode.get(`${combo.groupId}${combo.branchId}`);
    if (branch === undefined) continue;
    const from = materialNode.get(combo.materialId) as number;
    const edgeIndex = flow.addEdge(from, branch, totalDemand, -combo.profit);
    comboEdges.push({
      materialId: combo.materialId,
      groupId: combo.groupId,
      branchId: combo.branchId,
      from,
      edgeIndex,
    });
  }

  for (const group of activeGroups) {
    for (const [branchId, quota] of group.quotas) {
      if (quota > 0) {
        flow.addEdge(branchNode.get(`${group.groupId}${branchId}`) as number, sink, quota, 0);
      }
    }
  }

  const { flow: pushed, cost } = flow.solve(source, sink, totalDemand);
  if (pushed < totalDemand) {
    return { ok: false, reason: 'infeasible' };
  }

  const allocations: CombinationAllocation[] = [];
  for (const edge of comboEdges) {
    const impressions = flow.flowOn(edge.from, edge.edgeIndex);
    if (impressions > 0) {
      allocations.push({
        materialId: edge.materialId,
        groupId: edge.groupId,
        branchId: edge.branchId,
        impressions,
      });
    }
  }

  return { ok: true, allocations, totalProfit: -cost };
}

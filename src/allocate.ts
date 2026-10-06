import type { AllocationRequest, AllocationResult } from "./types";
import type { BranchQuota, ComboAllocation } from "./types";
import { computeBranchQuotas } from "./quota";
import { MinCostFlowSolver } from "./minCostFlow";
import { groupKey, validateRequest } from "./validate";

/**
 * 生成满足全部投放约束、整体收益最高的分配方案。
 *
 * - 每个人群组的每个分支恰好获得其整数额度；
 * - 每份素材的总分配量不超过其曝光上限；
 * - 在满足上两条的前提下最大化 曝光量 × 收益分 之和；
 * - 无法满足全部额度时返回 { feasible: false }，不返回部分计划。
 *
 * 输入非法（如百分比合计不为 100、分支数不在 2..5 等）时抛出 Error。
 */
export function allocate(request: AllocationRequest): AllocationResult {
  validateRequest(request);

  // 1. 计算每个 (人群组, 分支) 的精确整数额度
  const branchQuotas: BranchQuota[] = [];
  for (const g of request.groups) {
    branchQuotas.push(...computeBranchQuotas(g));
  }

  // 2. 需求节点：只把额度 > 0 的分支放入流网络
  interface DemandNode {
    quota: BranchQuota;
    amount: number;
  }
  const demandNodes: DemandNode[] = [];
  const demandNodeIndex = new Map<string, number>();
  for (const q of branchQuotas) {
    if (q.quota === 0) continue;
    demandNodeIndex.set(
      `${groupKey(q.regionCode, q.segmentId)}${q.branchId}`,
      demandNodes.length,
    );
    demandNodes.push({ quota: q, amount: q.quota });
  }

  const materialCount = request.materials.length;
  const demandCount = demandNodes.length;
  const totalDemand = demandNodes.reduce((a, d) => a + d.amount, 0);
  if (totalDemand === 0) {
    return { feasible: true, branchQuotas, allocations: [], totalProfit: 0n };
  }

  const source = 0;
  const materialBase = 1;
  const demandBase = materialBase + materialCount;
  const sink = demandBase + demandCount;
  const solver = new MinCostFlowSolver(sink + 1);

  // 3. 源 -> 素材（曝光上限）
  const materialIndex = new Map<string, number>();
  request.materials.forEach((m, i) => {
    materialIndex.set(m.materialId, i);
    solver.addEdge({ from: source, to: materialBase + i, capacity: m.capacity, cost: 0 });
  });

  // 4. 素材 -> 需求节点（允许组合；同一 (素材, 组合) 重复时保留最高收益）
  //    费用 = -收益分；单条边流量不会超过需求方额度，以此作为边容量。
  const comboEdgeBest = new Map<string, number>(); // key -> profit
  for (const c of request.allowed) {
    const di = demandNodeIndex.get(`${groupKey(c.regionCode, c.segmentId)}${c.branchId}`);
    if (di === undefined) continue; // 额度为 0 的分支不分配
    const key = `${c.materialId}->${di}`;
    const prev = comboEdgeBest.get(key);
    if (prev === undefined || c.profitPerImpression > prev) {
      comboEdgeBest.set(key, c.profitPerImpression);
    }
  }
  interface ComboEdge {
    materialIdx: number;
    demandIdx: number;
    profit: number;
  }
  const comboEdges: ComboEdge[] = [];
  for (const [key, profit] of comboEdgeBest) {
    const sep = key.indexOf("->");
    const materialIdx = materialIndex.get(key.slice(0, sep))!;
    const demandIdx = Number(key.slice(sep + 2));
    comboEdges.push({ materialIdx, demandIdx, profit });
    solver.addEdge({
      from: materialBase + materialIdx,
      to: demandBase + demandIdx,
      capacity: demandNodes[demandIdx]!.amount,
      cost: -profit,
    });
  }

  // 5. 需求节点 -> 汇（精确额度）
  for (let i = 0; i < demandCount; i++) {
    solver.addEdge({ from: demandBase + i, to: sink, capacity: demandNodes[i]!.amount, cost: 0 });
  }

  // 6. 求解
  const comboEdgeOffset = materialCount;
  const sinkEdgeOffset = comboEdgeOffset + comboEdges.length;
  const result = solver.solve(source, sink, totalDemand);

  if (result.totalFlow < totalDemand) {
    const shortages: BranchQuota[] = [];
    for (let i = 0; i < demandCount; i++) {
      const served = result.edgeFlows[sinkEdgeOffset + i]!;
      if (served < demandNodes[i]!.amount) {
        shortages.push({ ...demandNodes[i]!.quota, quota: demandNodes[i]!.amount - served });
      }
    }
    return { feasible: false, shortages };
  }

  // 7. 汇总方案与精确总收益（bigint 累加，超出安全整数也不失真）
  const allocations: ComboAllocation[] = [];
  let totalProfit = 0n;
  for (let j = 0; j < comboEdges.length; j++) {
    const flow = result.edgeFlows[comboEdgeOffset + j]!;
    if (flow === 0) continue;
    const e = comboEdges[j]!;
    const q = demandNodes[e.demandIdx]!.quota;
    allocations.push({
      materialId: request.materials[e.materialIdx]!.materialId,
      regionCode: q.regionCode,
      segmentId: q.segmentId,
      branchId: q.branchId,
      impressions: flow,
    });
    totalProfit += BigInt(flow) * BigInt(e.profit);
  }

  return { feasible: true, branchQuotas, allocations, totalProfit };
}

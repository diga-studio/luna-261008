/** 实验分支：编号为正整数，整数百分比大于 0。 */
export interface BranchSpec {
  branchId: number;
  percent: number;
}

/** 投放人群组：地域码 + 细分人群标识，非负整数曝光需求，2-5 个分支。 */
export interface AudienceGroup {
  groupId: string;
  regionCode: string;
  segmentId: string;
  demand: number;
  branches: BranchSpec[];
}

/** 素材：非负整数曝光上限，由所有组合共同消耗。 */
export interface Material {
  materialId: string;
  capacity: number;
}

/** 允许投放组合：素材 × 人群组 × 分支，每次曝光的整数收益分（可为负）。 */
export interface AllowedCombination {
  materialId: string;
  groupId: string;
  branchId: number;
  profit: number;
}

export interface AllocationRequest {
  materials: Material[];
  groups: AudienceGroup[];
  combinations: AllowedCombination[];
}

/** 单个组合的分配结果：非负整数曝光量。 */
export interface CombinationAllocation {
  materialId: string;
  groupId: string;
  branchId: number;
  impressions: number;
}

export interface AllocationSuccess {
  ok: true;
  allocations: CombinationAllocation[];
  /** 总收益，精确整数（BigInt，不受安全整数范围限制）。 */
  totalProfit: bigint;
}

export interface AllocationFailure {
  ok: false;
  reason: 'infeasible';
}

export type AllocationResult = AllocationSuccess | AllocationFailure;

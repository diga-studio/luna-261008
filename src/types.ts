/**
 * RetailPulse 区域营销内容分配库 —— 公共类型定义。
 *
 * 所有数据仅保存在进程内存中，本库不做任何持久化。
 */

/** 实验分支：编号为正整数，百分比为大于 0 的整数。 */
export interface ExperimentBranchInput {
  branchId: number;
  percent: number;
}

/** 投放人群组：由地域码 + 细分人群标识共同确定。 */
export interface AudienceGroupInput {
  regionCode: string;
  segmentId: string;
  /** 非负整数曝光需求；为 0 时该组不分配曝光。 */
  demand: number;
  /** 2 至 5 个实验分支，百分比合计必须为 100。 */
  branches: ExperimentBranchInput[];
}

/** 素材：曝光上限由所有地域、人群组、分支共同消耗。 */
export interface MaterialInput {
  materialId: string;
  /** 非负整数曝光上限。 */
  capacity: number;
}

/** 允许投放的 素材 × 人群组 × 分支 组合及每次曝光的整数收益分。 */
export interface AllowedCombinationInput {
  materialId: string;
  regionCode: string;
  segmentId: string;
  branchId: number;
  /** 整数收益分，可以为负。 */
  profitPerImpression: number;
}

/** 单次分配请求的全部输入。 */
export interface AllocationRequest {
  materials: MaterialInput[];
  groups: AudienceGroupInput[];
  allowed: AllowedCombinationInput[];
}

/** 某人群组内一个分支的整数曝光额度。 */
export interface BranchQuota {
  regionCode: string;
  segmentId: string;
  branchId: number;
  /** 按最大余数法分摊后的精确整数曝光额度。 */
  quota: number;
}

/** 一个组合实际分配到的曝光量（仅返回曝光量大于 0 的组合）。 */
export interface ComboAllocation {
  materialId: string;
  regionCode: string;
  segmentId: string;
  branchId: number;
  impressions: number;
}

/** 分配成功：满足全部额度与共享上限，且总收益最大。 */
export interface AllocationSuccess {
  feasible: true;
  /** 所有人群组所有分支的整数额度（需求为 0 的组额度全为 0）。 */
  branchQuotas: BranchQuota[];
  /** 曝光量大于 0 的组合分配结果。 */
  allocations: ComboAllocation[];
  /**
   * 总收益（曝光量 × 收益分 之和）。
   * 使用 bigint 保证绝对值超过 Number.MAX_SAFE_INTEGER 时仍然精确。
   */
  totalProfit: bigint;
}

/** 分配失败：存在无法满足全部额度的情形，不返回部分完成的计划。 */
export interface AllocationInfeasible {
  feasible: false;
  /** 缺口说明（哪些分支的额度无法被满足）。 */
  shortages: BranchQuota[];
}

export type AllocationResult = AllocationSuccess | AllocationInfeasible;

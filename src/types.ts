/** 物料类型：外购件 / 普通自制件 / 幻影件 */
export type MaterialType = 'PURCHASED' | 'MANUFACTURED' | 'PHANTOM';

/** 物料主数据 */
export interface MaterialMaster {
  readonly id: string;
  readonly type: MaterialType;
}

/** BOM 修订。有效期按日：[validFrom, validTo)，生效日含当日，失效日不含当日。 */
export interface BomRevision {
  readonly id: string;
  readonly materialId: string;
  /** 生效日（含），格式 YYYY-MM-DD */
  readonly validFrom: string;
  /** 失效日（不含），格式 YYYY-MM-DD */
  readonly validTo: string;
}

/** BOM 明细行。usage/lossRate 为十进制文本。lossRate 缺省 2.5。 */
export interface BomLine {
  readonly revisionId: string;
  readonly componentId: string;
  /** 组件用量，十进制文本，>0，最多 6 位小数 */
  readonly usage: string;
  /** 损耗率百分比，十进制文本，0~100，最多 4 位小数；缺省 "2.5" */
  readonly lossRate?: string;
}

/** 调用方提供的完整 BOM 档案（装载到内存） */
export interface BomArchiveInput {
  readonly materials: readonly MaterialMaster[];
  readonly revisions: readonly BomRevision[];
  readonly lines: readonly BomLine[];
}

/** 根件需求：普通自制件，整数需求，显式指定修订（不受有效期限制） */
export interface RootRequirement {
  readonly materialId: string;
  readonly revisionId: string;
  /** 整数十进制文本，1 ~ 1000000000000 */
  readonly quantity: string;
}

/** 一次试算的输入 */
export interface TrialInput {
  /** 生产日期，格式 YYYY-MM-DD，全部根件共用 */
  readonly productionDate: string;
  readonly roots: readonly RootRequirement[];
}

/** 普通自制件生产数量（按物料+修订区分），quantity 为整件十进制文本 */
export interface ProductionQuantity {
  readonly materialId: string;
  readonly revisionId: string;
  readonly quantity: string;
}

/** 外购件领料数量（按物料合并），quantity 为整件十进制文本 */
export interface IssueQuantity {
  readonly materialId: string;
  readonly quantity: string;
}

/** 试算结果 */
export interface TrialResult {
  readonly production: readonly ProductionQuantity[];
  readonly issue: readonly IssueQuantity[];
}

export type TrialErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_MATERIAL'
  | 'UNKNOWN_REVISION'
  | 'REVISION_MATERIAL_MISMATCH'
  | 'ROOT_NOT_MANUFACTURED'
  | 'NO_EFFECTIVE_REVISION'
  | 'CYCLE_DETECTED'
  | 'DEPTH_EXCEEDED';

export class TrialError extends Error {
  readonly code: TrialErrorCode;
  constructor(code: TrialErrorCode, message: string) {
    super(message);
    this.name = 'TrialError';
    this.code = code;
  }
}

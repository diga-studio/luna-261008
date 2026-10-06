/** 物料类型：外购件 / 普通自制件 / 幻影件 */
export type MaterialType = 'purchased' | 'manufactured' | 'phantom';

/** 物料主数据 */
export interface MaterialInput {
  materialId: string;
  type: MaterialType;
}

/** BOM 明细行。quantity 为十进制文本（最多 6 位小数），lossRate 为百分数文本（0~100，最多 4 位小数），缺省 2.5 */
export interface BomLineInput {
  componentId: string;
  quantity: string;
  lossRate?: string;
}

/** BOM 修订。日期为 YYYY-MM-DD；effectiveFrom 含当日，effectiveTo 不含当日，缺省表示永久有效 */
export interface RevisionInput {
  revisionId: string;
  materialId: string;
  effectiveFrom: string;
  effectiveTo?: string;
  lines: BomLineInput[];
}

/** 完整 BOM 档案（由调用方提供） */
export interface BomArchiveData {
  materials: MaterialInput[];
  revisions: RevisionInput[];
}

/** 根件需求：普通自制件，整数数量（十进制文本），显式指定修订 */
export interface RootDemandInput {
  materialId: string;
  revisionId: string;
  quantity: string;
}

/** 试算输入 */
export interface TrialInput {
  productionDate: string;
  roots: RootDemandInput[];
}

/** 普通自制件生产数量（按物料+修订区分，整件十进制文本） */
export interface ProductionEntry {
  materialId: string;
  revisionId: string;
  quantity: string;
}

/** 外购件领料数量（按物料合并，整件十进制文本） */
export interface ConsumptionEntry {
  materialId: string;
  quantity: string;
}

/** 试算结果 */
export interface TrialResult {
  production: ProductionEntry[];
  consumption: ConsumptionEntry[];
}

/** 试算失败原因 */
export type TrialErrorCode = 'CYCLE' | 'MAX_DEPTH' | 'NO_VALID_REVISION' | 'INVALID_INPUT';

export class TrialError extends Error {
  readonly code: TrialErrorCode;
  constructor(code: TrialErrorCode, message: string) {
    super(message);
    this.name = 'TrialError';
    this.code = code;
  }
}

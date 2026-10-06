import { type BomArchiveData, type MaterialType } from './types.js';
/** 预处理后的 BOM 明细行（内部表示） */
export interface BomLine {
    componentId: string;
    usageScaled: bigint;
    lossFactor: bigint;
}
/** 预处理后的 BOM 修订（内部表示） */
export interface Revision {
    revisionId: string;
    materialId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    lines: BomLine[];
}
/**
 * BOM 档案：装载时完成校验与索引，之后可反复用于多次试算。
 */
export declare class BomArchive {
    private readonly materials;
    private readonly revisionsById;
    private readonly revisionsByMaterial;
    constructor(data: BomArchiveData);
    materialType(materialId: string): MaterialType | undefined;
    revisionById(revisionId: string): Revision | undefined;
    /** 选择某日期的有效修订（effectiveFrom <= date < effectiveTo），无则返回 undefined */
    effectiveRevision(materialId: string, date: string): Revision | undefined;
}

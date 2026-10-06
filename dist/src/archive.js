import { parseDecimal, parseLossFactor } from './decimal.js';
import { TrialError } from './types.js';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(text, what) {
    if (!DATE_RE.test(text)) {
        throw new TrialError('INVALID_INPUT', `${what} 不是合法的 YYYY-MM-DD 日期: ${JSON.stringify(text)}`);
    }
}
/**
 * BOM 档案：装载时完成校验与索引，之后可反复用于多次试算。
 */
export class BomArchive {
    materials = new Map();
    revisionsById = new Map();
    revisionsByMaterial = new Map();
    constructor(data) {
        for (const m of data.materials) {
            if (this.materials.has(m.materialId)) {
                throw new TrialError('INVALID_INPUT', `物料重复定义: ${m.materialId}`);
            }
            this.materials.set(m.materialId, m.type);
        }
        for (const r of data.revisions) {
            const type = this.materials.get(r.materialId);
            if (type === undefined) {
                throw new TrialError('INVALID_INPUT', `修订 ${r.revisionId} 引用了未定义的物料: ${r.materialId}`);
            }
            if (type === 'purchased') {
                throw new TrialError('INVALID_INPUT', `外购件不应拥有 BOM 修订: ${r.materialId}`);
            }
            if (this.revisionsById.has(r.revisionId)) {
                throw new TrialError('INVALID_INPUT', `修订重复定义: ${r.revisionId}`);
            }
            checkDate(r.effectiveFrom, `修订 ${r.revisionId} 生效日`);
            if (r.effectiveTo !== undefined) {
                checkDate(r.effectiveTo, `修订 ${r.revisionId} 失效日`);
                if (r.effectiveTo <= r.effectiveFrom) {
                    throw new TrialError('INVALID_INPUT', `修订 ${r.revisionId} 失效日必须晚于生效日`);
                }
            }
            const lines = r.lines.map((line) => {
                if (!this.materials.has(line.componentId)) {
                    throw new TrialError('INVALID_INPUT', `修订 ${r.revisionId} 的明细引用了未定义的组件: ${line.componentId}`);
                }
                return {
                    componentId: line.componentId,
                    usageScaled: parseDecimal(line.quantity, 6),
                    lossFactor: parseLossFactor(line.lossRate),
                };
            });
            const revision = {
                revisionId: r.revisionId,
                materialId: r.materialId,
                effectiveFrom: r.effectiveFrom,
                effectiveTo: r.effectiveTo ?? null,
                lines,
            };
            this.revisionsById.set(r.revisionId, revision);
            let list = this.revisionsByMaterial.get(r.materialId);
            if (list === undefined) {
                list = [];
                this.revisionsByMaterial.set(r.materialId, list);
            }
            list.push(revision);
        }
        // 同一物料的修订有效期不得重叠；按生效日排序以便选择
        for (const [materialId, list] of this.revisionsByMaterial) {
            list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
            for (let i = 1; i < list.length; i++) {
                const prev = list[i - 1];
                const cur = list[i];
                if (prev.effectiveTo === null || prev.effectiveTo > cur.effectiveFrom) {
                    throw new TrialError('INVALID_INPUT', `物料 ${materialId} 的修订 ${prev.revisionId} 与 ${cur.revisionId} 有效期重叠`);
                }
            }
        }
    }
    materialType(materialId) {
        return this.materials.get(materialId);
    }
    revisionById(revisionId) {
        return this.revisionsById.get(revisionId);
    }
    /** 选择某日期的有效修订（effectiveFrom <= date < effectiveTo），无则返回 undefined */
    effectiveRevision(materialId, date) {
        const list = this.revisionsByMaterial.get(materialId);
        if (list === undefined) {
            return undefined;
        }
        for (const r of list) {
            if (r.effectiveFrom <= date && (r.effectiveTo === null || date < r.effectiveTo)) {
                return r;
            }
        }
        return undefined;
    }
}

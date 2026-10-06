import { BomArchiveInput, MaterialType, TrialError } from './types.js';
import { Decimal, addDecimal, decimalFromBigint, parseDecimal } from './decimal.js';

/** 预处理后的明细行（用量、损耗系数已解析为精确十进制） */
export interface PreparedLine {
  readonly componentId: string;
  readonly usage: Decimal;
  /** 1 + lossRate/100 */
  readonly lossFactor: Decimal;
}

export interface PreparedRevision {
  readonly id: string;
  readonly materialId: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly lines: readonly PreparedLine[];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_USAGE = 1000000n;
const MAX_LOSS_RATE = 100n;

function checkDate(text: string, what: string): void {
  const m = DATE_RE.exec(text);
  if (m === null) {
    throw new TrialError('INVALID_INPUT', `invalid date for ${what}: ${JSON.stringify(text)}`);
  }
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new TrialError('INVALID_INPUT', `invalid date for ${what}: ${JSON.stringify(text)}`);
  }
}

function parseUsage(text: string, what: string): Decimal {
  let d: Decimal;
  try {
    d = parseDecimal(text, 6, what);
  } catch (e) {
    throw new TrialError('INVALID_INPUT', (e as Error).message);
  }
  if (d.mantissa <= 0n) {
    throw new TrialError('INVALID_INPUT', `usage must be positive for ${what}: ${JSON.stringify(text)}`);
  }
  if (d.scale === 0 && d.mantissa > MAX_USAGE) {
    throw new TrialError('INVALID_INPUT', `usage exceeds 1000000 for ${what}: ${JSON.stringify(text)}`);
  }
  if (d.scale > 0 && d.mantissa > MAX_USAGE * 10n ** BigInt(d.scale)) {
    throw new TrialError('INVALID_INPUT', `usage exceeds 1000000 for ${what}: ${JSON.stringify(text)}`);
  }
  return d;
}

function parseLossRate(text: string, what: string): Decimal {
  let d: Decimal;
  try {
    d = parseDecimal(text, 4, what);
  } catch (e) {
    throw new TrialError('INVALID_INPUT', (e as Error).message);
  }
  const limit = MAX_LOSS_RATE * 10n ** BigInt(d.scale);
  if (d.mantissa > limit) {
    throw new TrialError('INVALID_INPUT', `loss rate out of range 0..100 for ${what}: ${JSON.stringify(text)}`);
  }
  return d;
}

/** 装载并校验档案，建立索引；之后可反复用于多次试算。 */
export class BomArchive {
  private readonly types = new Map<string, MaterialType>();
  private readonly revisionsById = new Map<string, PreparedRevision>();
  private readonly revisionsByMaterial = new Map<string, PreparedRevision[]>();

  constructor(input: BomArchiveInput) {
    for (const mat of input.materials) {
      if (this.types.has(mat.id)) {
        throw new TrialError('INVALID_INPUT', `duplicate material id: ${mat.id}`);
      }
      if (mat.type !== 'PURCHASED' && mat.type !== 'MANUFACTURED' && mat.type !== 'PHANTOM') {
        throw new TrialError('INVALID_INPUT', `unknown material type for ${mat.id}: ${mat.type}`);
      }
      this.types.set(mat.id, mat.type);
    }

    const linesByRevision = new Map<string, PreparedLine[]>();
    for (const line of input.lines) {
      const what = `line of revision ${line.revisionId} component ${line.componentId}`;
      if (!this.types.has(line.componentId)) {
        throw new TrialError('UNKNOWN_MATERIAL', `unknown component material: ${line.componentId}`);
      }
      const usage = parseUsage(line.usage, what);
      const lossRate = parseLossRate(line.lossRate ?? '2.5', what);
      // lossFactor = 1 + lossRate/100
      const factor: Decimal = addDecimal(decimalFromBigint(1n), {
        mantissa: lossRate.mantissa,
        scale: lossRate.scale + 2,
      });
      let list = linesByRevision.get(line.revisionId);
      if (list === undefined) {
        list = [];
        linesByRevision.set(line.revisionId, list);
      }
      list.push({ componentId: line.componentId, usage, lossFactor: factor });
    }

    for (const rev of input.revisions) {
      if (this.revisionsById.has(rev.id)) {
        throw new TrialError('INVALID_INPUT', `duplicate revision id: ${rev.id}`);
      }
      if (!this.types.has(rev.materialId)) {
        throw new TrialError('UNKNOWN_MATERIAL', `revision ${rev.id} references unknown material: ${rev.materialId}`);
      }
      if (this.types.get(rev.materialId) === 'PURCHASED') {
        throw new TrialError('INVALID_INPUT', `purchased material ${rev.materialId} must not have BOM revisions`);
      }
      checkDate(rev.validFrom, `validFrom of revision ${rev.id}`);
      checkDate(rev.validTo, `validTo of revision ${rev.id}`);
      if (!(rev.validFrom < rev.validTo)) {
        throw new TrialError('INVALID_INPUT', `revision ${rev.id} has empty validity range`);
      }
      const prepared: PreparedRevision = {
        id: rev.id,
        materialId: rev.materialId,
        validFrom: rev.validFrom,
        validTo: rev.validTo,
        lines: linesByRevision.get(rev.id) ?? [],
      };
      this.revisionsById.set(rev.id, prepared);
      let list = this.revisionsByMaterial.get(rev.materialId);
      if (list === undefined) {
        list = [];
        this.revisionsByMaterial.set(rev.materialId, list);
      }
      list.push(prepared);
    }

    for (const [revId, lines] of linesByRevision) {
      if (!this.revisionsById.has(revId)) {
        throw new TrialError('INVALID_INPUT', `line references unknown revision: ${revId}`);
      }
    }

    // 同一物料的修订有效期不得重叠
    for (const [materialId, list] of this.revisionsByMaterial) {
      list.sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        if (cur.validFrom < prev.validTo) {
          throw new TrialError(
            'INVALID_INPUT',
            `overlapping revisions for material ${materialId}: ${prev.id} and ${cur.id}`,
          );
        }
      }
    }
  }

  materialType(id: string): MaterialType | undefined {
    return this.types.get(id);
  }

  hasRevision(revisionId: string): boolean {
    return this.revisionsById.has(revisionId);
  }

  revision(id: string): PreparedRevision | undefined {
    return this.revisionsById.get(id);
  }

  /** 物料在某生产日期下有效的修订；无有效修订返回 undefined。 */
  effectiveRevision(materialId: string, date: string): PreparedRevision | undefined {
    const list = this.revisionsByMaterial.get(materialId);
    if (list === undefined) {
      return undefined;
    }
    for (const rev of list) {
      if (rev.validFrom <= date && date < rev.validTo) {
        return rev;
      }
    }
    return undefined;
  }
}

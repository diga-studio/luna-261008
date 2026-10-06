import { BomArchive } from '../src/archive.js';
import type { BomArchiveInput, BomLine, BomRevision, MaterialMaster } from '../src/types.js';

export function mat(id: string, type: MaterialMaster['type']): MaterialMaster {
  return { id, type };
}

export function rev(id: string, materialId: string, validFrom: string, validTo: string): BomRevision {
  return { id, materialId, validFrom, validTo };
}

export function line(revisionId: string, componentId: string, usage: string, lossRate?: string): BomLine {
  return lossRate === undefined
    ? { revisionId, componentId, usage }
    : { revisionId, componentId, usage, lossRate };
}

export function makeArchive(input: BomArchiveInput): BomArchive {
  return new BomArchive(input);
}

/** 独立参照：任意精度分数（num/den，约分），与引擎的定点十进制实现无关。 */
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num < 0n ? -num : num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static parse(text: string): Fraction {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (m === null) throw new Error(`bad decimal: ${text}`);
    const frac = m[2] ?? '';
    return new Fraction(BigInt(m[1] + frac), 10n ** BigInt(frac.length));
  }

  add(o: Fraction): Fraction {
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return new Fraction(this.num * o.num, this.den * o.den);
  }

  ceil(): bigint {
    const q = this.num / this.den;
    return this.num % this.den === 0n ? q : q + 1n;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export interface RefResult {
  production: Map<string, bigint>; // key: JSON [materialId, revisionId]
  issue: Map<string, bigint>; // key: materialId
}

/**
 * 独立参照试算：发现有效图后按拓扑序聚合需求（分数运算），
 * 自制件取整后展开，幻影件精确展开，外购件最终取整。
 * 仅适用于小规模无环档案。
 */
export function referenceTrial(
  input: BomArchiveInput,
  productionDate: string,
  roots: readonly { materialId: string; revisionId: string; quantity: string }[],
): RefResult {
  const types = new Map(input.materials.map((m) => [m.id, m.type]));
  const linesByRev = new Map<string, BomLine[]>();
  for (const l of input.lines) {
    const list = linesByRev.get(l.revisionId) ?? [];
    list.push(l);
    linesByRev.set(l.revisionId, list);
  }
  const effective = (materialId: string): BomRevision | undefined =>
    input.revisions.find(
      (r) => r.materialId === materialId && r.validFrom <= productionDate && productionDate < r.validTo,
    );

  const demand = new Map<string, Fraction>();
  const nodeType = new Map<string, string>();
  const children = new Map<string, { key: string; factor: Fraction }[]>();
  const indegree = new Map<string, number>();

  const ensure = (key: string, type: string) => {
    if (!nodeType.has(key)) {
      nodeType.set(key, type);
      demand.set(key, new Fraction(0n));
      children.set(key, []);
      indegree.set(key, 0);
    }
  };

  const discover = (key: string, stack: Set<string>) => {
    if (stack.has(key)) throw new Error('cycle in reference input');
    const nextStack = new Set(stack).add(key);
    const type = nodeType.get(key)!;
    if (type === 'PURCHASED') return;
    if ((children.get(key) ?? []).length > 0) return;
    const [, materialId, revisionId] = JSON.parse(key) as [string, string, string];
    for (const l of linesByRev.get(revisionId) ?? []) {
      const ctype = types.get(l.componentId)!;
      const factor = Fraction.parse(l.usage).mul(
        new Fraction(1n).add(Fraction.parse(l.lossRate ?? '2.5').mul(new Fraction(1n, 100n))),
      );
      let ckey: string;
      if (ctype === 'PURCHASED') {
        ckey = JSON.stringify(['P', l.componentId]);
        ensure(ckey, 'PURCHASED');
      } else {
        const eff = effective(l.componentId);
        if (eff === undefined) throw new Error(`no effective revision: ${l.componentId}`);
        ckey = JSON.stringify(['E', l.componentId, eff.id]);
        ensure(ckey, ctype);
      }
      children.get(key)!.push({ key: ckey, factor });
      indegree.set(ckey, indegree.get(ckey)! + 1);
      discover(ckey, nextStack);
    }
  };

  for (const r of roots) {
    const key = JSON.stringify(['E', r.materialId, r.revisionId]);
    ensure(key, 'MANUFACTURED');
    demand.set(key, demand.get(key)!.add(new Fraction(BigInt(r.quantity))));
  }
  for (const key of [...nodeType.keys()]) discover(key, new Set());

  const queue = [...nodeType.keys()].filter((k) => indegree.get(k) === 0);
  const production = new Map<string, bigint>();
  const issue = new Map<string, bigint>();
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]!;
    const type = nodeType.get(key)!;
    let qty: Fraction;
    if (type === 'MANUFACTURED') {
      const c = demand.get(key)!.ceil();
      production.set(key, c);
      qty = new Fraction(c);
    } else if (type === 'PHANTOM') {
      qty = demand.get(key)!;
    } else {
      issue.set(JSON.parse(key)[1] as string, demand.get(key)!.ceil());
      continue;
    }
    for (const c of children.get(key)!) {
      demand.set(c.key, demand.get(c.key)!.add(qty.mul(c.factor)));
      const d = indegree.get(c.key)! - 1;
      indegree.set(c.key, d);
      if (d === 0) queue.push(c.key);
    }
  }
  return { production, issue };
}

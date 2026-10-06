import { parseCidr, type AddressFamily } from './ip.js';
import type { Rect } from './rect.js';
import type { ConcreteProtocol, Rule } from './types.js';

/** 一条规则在某个具体协议下的匹配矩形。 */
export interface RuleAtom {
  readonly protocol: ConcreteProtocol;
  readonly rect: Rect;
}

/** 编译后的规则：按检查顺序排列，携带展开后的原子矩形。 */
export interface CompiledRule {
  readonly rule: Rule;
  readonly family: AddressFamily;
  readonly atoms: readonly RuleAtom[];
}

export const MAX_RULES = 500;
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 1000;
export const MIN_PORT = 0;
export const MAX_PORT = 65535;

function validateRule(rule: Rule, index: number): void {
  if (typeof rule.id !== 'string' || rule.id.length === 0) {
    throw new Error(`rule #${index}: id must be a non-empty string`);
  }
  if (
    !Number.isInteger(rule.priority) ||
    rule.priority < MIN_PRIORITY ||
    rule.priority > MAX_PRIORITY
  ) {
    throw new Error(`rule ${rule.id}: priority must be an integer in [1, 1000]`);
  }
  const hasPorts = rule.protocol === 'TCP' || rule.protocol === 'UDP';
  if (hasPorts) {
    const range = rule.portRange;
    if (range === undefined) {
      throw new Error(`rule ${rule.id}: ${rule.protocol} rule requires portRange`);
    }
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < MIN_PORT ||
      range.end > MAX_PORT ||
      range.start > range.end
    ) {
      throw new Error(`rule ${rule.id}: portRange must be a closed interval within [0, 65535]`);
    }
  } else if (rule.portRange !== undefined) {
    throw new Error(`rule ${rule.id}: ${rule.protocol} rule must not carry portRange`);
  }
}

function buildAtoms(rule: Rule, src: Rect['srcMin'], srcEnd: Rect['srcMax'], dst: Rect['srcMin'], dstEnd: Rect['srcMax']): RuleAtom[] {
  const base = { srcMin: src, srcMax: srcEnd, dstMin: dst, dstMax: dstEnd };
  switch (rule.protocol) {
    case 'TCP':
    case 'UDP': {
      const port = rule.portRange!;
      return [
        {
          protocol: rule.protocol,
          rect: { ...base, portMin: port.start, portMax: port.end },
        },
      ];
    }
    case 'ICMP':
      // ICMP 无端口维度，用单点 [0,0] 表示。
      return [{ protocol: 'ICMP', rect: { ...base, portMin: 0, portMax: 0 } }];
    case 'ANY':
      // ANY 覆盖三种具体协议；TCP/UDP 覆盖全部端口，ICMP 无端口。
      return [
        { protocol: 'TCP', rect: { ...base, portMin: MIN_PORT, portMax: MAX_PORT } },
        { protocol: 'UDP', rect: { ...base, portMin: MIN_PORT, portMax: MAX_PORT } },
        { protocol: 'ICMP', rect: { ...base, portMin: 0, portMax: 0 } },
      ];
  }
}

/** 校验策略并按“优先级升序、同优先级按输入顺序”编译规则。 */
export function compilePolicy(rules: readonly Rule[]): CompiledRule[] {
  if (rules.length > MAX_RULES) {
    throw new Error(`policy has ${rules.length} rules, exceeding the maximum of ${MAX_RULES}`);
  }
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    validateRule(rule, index);
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  });
  // Array.prototype.sort 是稳定排序，同优先级保持输入顺序。
  const ordered = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index);
  return ordered.map(({ rule }) => {
    const src = parseCidr(rule.sourceCidr);
    const dst = parseCidr(rule.destCidr);
    if (src.family !== dst.family) {
      throw new Error(`rule ${rule.id}: source and destination CIDR must share an address family`);
    }
    return {
      rule,
      family: src.family,
      atoms: buildAtoms(rule, src.start, src.end, dst.start, dst.end),
    };
  });
}

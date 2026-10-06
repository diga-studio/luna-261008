import { compilePolicy, type CompiledRule } from './compile.js';
import { formatAddress } from './ip.js';
import { subtractRect, type Rect } from './rect.js';
import type { Connection, Rule, RuleAudit } from './types.js';

function witnessFromRect(rule: CompiledRule, protocol: Connection['protocol'], rect: Rect): Connection {
  const base = {
    direction: rule.rule.direction,
    protocol,
    sourceAddress: formatAddress(rule.family, rect.srcMin),
    destAddress: formatAddress(rule.family, rect.dstMin),
  };
  if (protocol === 'ICMP') {
    return base;
  }
  return { ...base, destPort: rect.portMin };
}

/**
 * 判断规则的某个原子是否被前序规则完全遮蔽。
 * 返回剩余的第一个矩形；完全遮蔽时返回 null。
 */
function firstUncovered(
  atomRect: Rect,
  protocol: Connection['protocol'],
  current: CompiledRule,
  earlier: readonly CompiledRule[],
): Rect | null {
  let fragments: Rect[] = [atomRect];
  for (const prior of earlier) {
    if (prior.family !== current.family || prior.rule.direction !== current.rule.direction) {
      continue;
    }
    for (const priorAtom of prior.atoms) {
      if (priorAtom.protocol !== protocol) {
        continue;
      }
      fragments = subtractRect(fragments, priorAtom.rect);
      if (fragments.length === 0) {
        return null;
      }
    }
  }
  return fragments[0]!;
}

/** 审查整份策略，对每条规则给出可达/完全遮蔽结论（按输入顺序返回）。 */
export function auditPolicy(rules: readonly Rule[]): RuleAudit[] {
  const compiled = compilePolicy(rules);
  const audits: RuleAudit[] = [];
  for (let i = 0; i < compiled.length; i++) {
    const current = compiled[i]!;
    const earlier = compiled.slice(0, i);
    let witness: Connection | undefined;
    for (const atom of current.atoms) {
      const rect = firstUncovered(atom.rect, atom.protocol, current, earlier);
      if (rect !== null) {
        witness = witnessFromRect(current, atom.protocol, rect);
        break;
      }
    }
    audits.push(
      witness === undefined
        ? { ruleId: current.rule.id, status: 'shadowed' }
        : { ruleId: current.rule.id, status: 'reachable', witness },
    );
  }
  // 按输入顺序返回结果。
  const orderById = new Map(rules.map((rule, index) => [rule.id, index]));
  audits.sort((a, b) => orderById.get(a.ruleId)! - orderById.get(b.ruleId)!);
  return audits;
}

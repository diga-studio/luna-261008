import { describe, expect, it } from 'vitest';
import { auditPolicy, evaluateConnection } from '../src/index.js';
import type { Rule } from '../src/index.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成 500 条混合地址族、大量交叉重叠的规则。 */
function largePolicy(seed: number, count: number): Rule[] {
  const rand = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const rules: Rule[] = [];
  for (let i = 0; i < count; i++) {
    const v4 = i % 2 === 0;
    const protocol = pick(['TCP', 'UDP', 'ICMP', 'ANY'] as const);
    let sourceCidr: string;
    let destCidr: string;
    if (v4) {
      // 小前缀制造大量重叠。
      const a = 10;
      const b = Math.floor(rand() * 4);
      const prefix = pick([8, 9, 10, 12, 16] as const);
      sourceCidr = `${a}.${b}.0.0/${prefix}`;
      destCidr = `192.168.${Math.floor(rand() * 8)}.0/${pick([16, 20, 24] as const)}`;
    } else {
      const block = Math.floor(rand() * 256).toString(16);
      sourceCidr = `2001:db8:${block}::/${pick([32, 40, 48] as const)}`;
      destCidr = `fd00:${block}::/${pick([16, 32, 48] as const)}`;
    }
    const p1 = Math.floor(rand() * 65536);
    const p2 = Math.min(65535, p1 + Math.floor(rand() * 20000));
    rules.push({
      id: `rule-${i}`,
      priority: 1 + Math.floor(rand() * 1000),
      direction: pick(['inbound', 'outbound'] as const),
      protocol,
      sourceCidr,
      destCidr,
      action: pick(['allow', 'deny', 'log'] as const),
      ...(protocol === 'TCP' || protocol === 'UDP'
        ? { portRange: { start: p1, end: p2 } }
        : {}),
    });
  }
  return rules;
}

describe('scale: 500 mixed-family rules', () => {
  it('completes within 15s and 256 MiB, with consistent verdicts', () => {
    const rules = largePolicy(42, 500);
    expect(rules.length).toBe(500);
    const before = process.memoryUsage();
    const start = performance.now();
    const audits = auditPolicy(rules);
    const elapsedMs = performance.now() - start;
    const after = process.memoryUsage();
    expect(audits.length).toBe(500);
    expect(elapsedMs).toBeLessThan(15000);
    const heapGrowth = after.heapUsed - before.heapUsed;
    const rssGrowth = after.rss - before.rss;
    expect(Math.max(heapGrowth, rssGrowth)).toBeLessThan(256 * 1024 * 1024);
    // 每条可达规则的见证都必须真实首命中该规则。
    for (const audit of audits) {
      if (audit.status === 'reachable') {
        expect(evaluateConnection(rules, audit.witness!).ruleId).toBe(audit.ruleId);
      }
    }
  }, 30000);
});

describe('same-priority ordering semantics', () => {
  const base = {
    direction: 'inbound' as const,
    protocol: 'TCP' as const,
    sourceCidr: '10.0.0.0/8',
    destCidr: '10.0.0.0/8',
    portRange: { start: 80, end: 80 },
  };

  it('input order breaks priority ties', () => {
    const firstWins: Rule[] = [
      { ...base, id: 'a', priority: 5, action: 'allow' },
      { ...base, id: 'b', priority: 5, action: 'deny' },
    ];
    const audits = auditPolicy(firstWins);
    expect(audits.find((x) => x.ruleId === 'a')!.status).toBe('reachable');
    expect(audits.find((x) => x.ruleId === 'b')!.status).toBe('shadowed');

    const swapped: Rule[] = [
      { ...base, id: 'b', priority: 5, action: 'deny' },
      { ...base, id: 'a', priority: 5, action: 'allow' },
    ];
    const swappedAudits = auditPolicy(swapped);
    expect(swappedAudits.find((x) => x.ruleId === 'b')!.status).toBe('reachable');
    expect(swappedAudits.find((x) => x.ruleId === 'a')!.status).toBe('shadowed');

    const conn = {
      direction: 'inbound' as const,
      protocol: 'TCP' as const,
      sourceAddress: '10.1.2.3',
      destAddress: '10.4.5.6',
      destPort: 80,
    };
    expect(evaluateConnection(firstWins, conn)).toEqual({ ruleId: 'a', action: 'allow' });
    expect(evaluateConnection(swapped, conn)).toEqual({ ruleId: 'b', action: 'deny' });
  });

  it('same priority holds across mixed families in the large policy', () => {
    // 在大策略前放两条同优先级同条件的规则，输入在前的赢。
    const rules = largePolicy(7, 498);
    const head: Rule[] = [
      { ...base, id: 'tie-first', priority: 1, action: 'log' },
      { ...base, id: 'tie-second', priority: 1, action: 'allow' },
    ];
    const audits = auditPolicy([...head, ...rules]);
    expect(audits.find((x) => x.ruleId === 'tie-first')!.status).toBe('reachable');
    expect(audits.find((x) => x.ruleId === 'tie-second')!.status).toBe('shadowed');
  });
});

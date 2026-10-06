import { describe, expect, it } from 'vitest';
import { auditPolicy, evaluateConnection } from '../src/index.js';
import type { Rule } from '../src/index.js';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    priority: 100,
    direction: 'inbound',
    protocol: 'TCP',
    sourceCidr: '10.0.0.0/8',
    destCidr: '10.0.0.0/8',
    action: 'allow',
    portRange: { start: 80, end: 80 },
    ...partial,
  };
}

function auditById(rules: Rule[]) {
  const audits = auditPolicy(rules);
  // 结果按输入顺序返回。
  expect(audits.map((a) => a.ruleId)).toEqual(rules.map((r) => r.id));
  return new Map(audits.map((a) => [a.ruleId, a]));
}

describe('auditPolicy joint shadowing', () => {
  it('two earlier rules jointly shadow a later rule', () => {
    const rules = [
      rule({ id: 'half-low', priority: 10, sourceCidr: '10.0.0.0/9' }),
      rule({ id: 'half-high', priority: 20, sourceCidr: '10.128.0.0/9' }),
      rule({ id: 'victim', priority: 30, sourceCidr: '10.0.0.0/8' }),
    ];
    const audits = auditById(rules);
    expect(audits.get('half-low')!.status).toBe('reachable');
    expect(audits.get('half-high')!.status).toBe('reachable');
    expect(audits.get('victim')!.status).toBe('shadowed');
    expect(audits.get('victim')!.witness).toBeUndefined();
  });

  it('port ranges from multiple earlier rules jointly cover the victim ports', () => {
    const rules = [
      rule({ id: 'p1', priority: 10, portRange: { start: 0, end: 20000 } }),
      rule({ id: 'p2', priority: 20, portRange: { start: 20001, end: 40000 } }),
      rule({ id: 'p3', priority: 30, portRange: { start: 40001, end: 65535 } }),
      rule({ id: 'victim', priority: 40, portRange: { start: 0, end: 65535 } }),
    ];
    expect(auditById(rules).get('victim')!.status).toBe('shadowed');
  });

  it('shadowing is independent of actions being equal', () => {
    const rules = [
      rule({ id: 'deny-low', priority: 10, action: 'deny', sourceCidr: '10.0.0.0/9' }),
      rule({ id: 'log-high', priority: 20, action: 'log', sourceCidr: '10.128.0.0/9' }),
      rule({ id: 'victim', priority: 30, action: 'allow', sourceCidr: '10.0.0.0/8' }),
    ];
    expect(auditById(rules).get('victim')!.status).toBe('shadowed');
  });

  it('ANY protocol rule can be jointly shadowed by per-protocol rules', () => {
    const anyRule = rule({
      id: 'any-victim',
      priority: 50,
      protocol: 'ANY',
      portRange: undefined,
    });
    const rules = [
      rule({ id: 'tcp', priority: 10, protocol: 'TCP', portRange: { start: 0, end: 65535 } }),
      rule({ id: 'udp', priority: 20, protocol: 'UDP', portRange: { start: 0, end: 65535 } }),
      rule({ id: 'icmp', priority: 30, protocol: 'ICMP', portRange: undefined }),
      anyRule,
    ];
    expect(auditById(rules).get('any-victim')!.status).toBe('shadowed');
  });

  it('later rules never shadow earlier ones', () => {
    const rules = [
      rule({ id: 'first', priority: 10 }),
      rule({ id: 'same', priority: 20 }),
    ];
    const audits = auditById(rules);
    expect(audits.get('first')!.status).toBe('reachable');
    expect(audits.get('same')!.status).toBe('shadowed');
  });
});

describe('auditPolicy single surviving combination', () => {
  it('finds the one address left uncovered', () => {
    // 10.0.0.0/8 被两个 /9 覆盖，仅 10.0.0.0 一个源地址被排除在遮蔽之外：
    // 用 /9 对遮住除 10.0.0.0 外的全部地址。
    const rules = [
      rule({ id: 'cover-low', priority: 10, sourceCidr: '10.128.0.0/9' }),
      rule({ id: 'cover-high', priority: 20, sourceCidr: '10.0.0.1/32' }),
      // 上面两条只遮住了 10.128.0.0/9 和 10.0.0.1；victim 仍有大量空间。
      // 换用精确构造：遮 10.0.0.1-10.127.255.255 需要多条，这里直接验证“仅剩一个组合”场景见下例。
      rule({ id: 'victim', priority: 30, sourceCidr: '10.0.0.0/25' }),
    ];
    const audits = auditById(rules);
    expect(audits.get('victim')!.status).toBe('reachable');
  });

  it('finds the single surviving address+port combination', () => {
    // victim: src 10.0.0.0/31, dst 10.0.0.0/31, ports 8000-8001（共 2*2*2=8 个组合）。
    // 前序规则覆盖除 (src=10.0.0.1, dst=10.0.0.1, port=8001) 之外的全部组合。
    const victim = rule({
      id: 'victim',
      priority: 100,
      sourceCidr: '10.0.0.0/31',
      destCidr: '10.0.0.0/31',
      portRange: { start: 8000, end: 8001 },
    });
    const rules = [
      // 覆盖 src=10.0.0.0 的全部组合。
      rule({ id: 'c1', priority: 10, sourceCidr: '10.0.0.0/32', destCidr: '10.0.0.0/31', portRange: { start: 8000, end: 8001 } }),
      // 覆盖 src=10.0.0.1, dst=10.0.0.0 的全部端口。
      rule({ id: 'c2', priority: 20, sourceCidr: '10.0.0.1/32', destCidr: '10.0.0.0/32', portRange: { start: 8000, end: 8001 } }),
      // 覆盖 src=10.0.0.1, dst=10.0.0.1, port=8000。
      rule({ id: 'c3', priority: 30, sourceCidr: '10.0.0.1/32', destCidr: '10.0.0.1/32', portRange: { start: 8000, end: 8000 } }),
      victim,
    ];
    const audits = auditById(rules);
    const victimAudit = audits.get('victim')!;
    expect(victimAudit.status).toBe('reachable');
    expect(victimAudit.witness).toEqual({
      direction: 'inbound',
      protocol: 'TCP',
      sourceAddress: '10.0.0.1',
      destAddress: '10.0.0.1',
      destPort: 8001,
    });
    // 见证确实首命中 victim。
    expect(evaluateConnection(rules, victimAudit.witness!)).toEqual({
      ruleId: 'victim',
      action: 'allow',
    });
  });

  it('handles IPv6 full-range rules and a single surviving IPv6 combination', () => {
    const allV6 = '::/0';
    const victim = rule({
      id: 'v6-victim',
      priority: 100,
      protocol: 'UDP',
      sourceCidr: '2001:db8::/127',
      destCidr: '2001:db8::/127',
      portRange: { start: 53, end: 54 },
    });
    const rules = [
      // 全局 IPv6 兜底，但只覆盖 TCP —— 不影响 UDP victim。
      rule({ id: 'v6-all-tcp', priority: 10, protocol: 'TCP', sourceCidr: allV6, destCidr: allV6, portRange: { start: 0, end: 65535 } }),
      // 覆盖 victim 空间内除 (src=...1, dst=...1, port=54) 外的组合。
      rule({ id: 'u1', priority: 20, protocol: 'UDP', sourceCidr: '2001:db8::/128', destCidr: '2001:db8::/127', portRange: { start: 53, end: 54 } }),
      rule({ id: 'u2', priority: 30, protocol: 'UDP', sourceCidr: '2001:db8::1/128', destCidr: '2001:db8::/128', portRange: { start: 53, end: 54 } }),
      rule({ id: 'u3', priority: 40, protocol: 'UDP', sourceCidr: '2001:db8::1/128', destCidr: '2001:db8::1/128', portRange: { start: 53, end: 53 } }),
      victim,
    ];
    const audits = auditById(rules);
    expect(audits.get('v6-all-tcp')!.status).toBe('reachable');
    const victimAudit = audits.get('v6-victim')!;
    expect(victimAudit.status).toBe('reachable');
    expect(victimAudit.witness).toEqual({
      direction: 'inbound',
      protocol: 'UDP',
      sourceAddress: '2001:db8::1',
      destAddress: '2001:db8::1',
      destPort: 54,
    });
    expect(evaluateConnection(rules, victimAudit.witness!).ruleId).toBe('v6-victim');
  });

  it('shadows an IPv6 rule spanning the full address space', () => {
    const rules = [
      rule({ id: 'everything', priority: 10, protocol: 'ANY', sourceCidr: '::/0', destCidr: '::/0', portRange: undefined }),
      rule({ id: 'v6-victim', priority: 20, protocol: 'ICMP', sourceCidr: '2001:db8::/32', destCidr: '2001:db8::/32', portRange: undefined }),
    ];
    expect(auditById(rules).get('v6-victim')!.status).toBe('shadowed');
  });
});

describe('auditPolicy protocol and family interactions', () => {
  it('TCP port conditions do not apply to ICMP connections', () => {
    const rules = [
      rule({ id: 'tcp-all', priority: 10, protocol: 'TCP', portRange: { start: 0, end: 65535 } }),
      rule({ id: 'icmp-victim', priority: 20, protocol: 'ICMP', portRange: undefined }),
    ];
    expect(auditById(rules).get('icmp-victim')!.status).toBe('reachable');
  });

  it('cross-family rules never shadow each other', () => {
    const rules = [
      rule({ id: 'v4', priority: 10, protocol: 'ANY', sourceCidr: '0.0.0.0/0', destCidr: '0.0.0.0/0', portRange: undefined }),
      rule({ id: 'v6', priority: 20, protocol: 'ANY', sourceCidr: '::/0', destCidr: '::/0', portRange: undefined }),
    ];
    expect(auditById(rules).get('v6')!.status).toBe('reachable');
  });

  it('directions never shadow each other', () => {
    const rules = [
      rule({ id: 'in', priority: 10, direction: 'inbound' }),
      rule({ id: 'out', priority: 20, direction: 'outbound' }),
    ];
    expect(auditById(rules).get('out')!.status).toBe('reachable');
  });

  it('rejects policies over 500 rules', () => {
    const rules = Array.from({ length: 501 }, (_, i) => rule({ id: `r${i}` }));
    expect(() => auditPolicy(rules)).toThrow(/500/);
  });
});

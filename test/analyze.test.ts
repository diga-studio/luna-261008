import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePolicies,
  createMatcher,
  CycleEvidence,
  Policy,
  Protocol,
} from '../src/index';

/** 用匹配器独立逐跳复核证据：每跳确实可通行，且路径满足闭环约束。 */
function verifyEvidence(
  policies: readonly Policy[],
  evidence: CycleEvidence,
  protocol: Protocol,
  port: number,
): void {
  const matcher = createMatcher(policies);
  const segments = evidence.segments;
  assert.ok(segments.length >= 3, '闭环至少经过两个不同网段并返回起点');
  assert.equal(segments[0], segments[segments.length - 1], '首尾必须相同');
  const inner = segments.slice(0, -1);
  assert.equal(new Set(inner).size, inner.length, '除首尾外不得重复网段');
  assert.ok(new Set(inner).size >= 2, '至少两个不同网段');
  assert.equal(evidence.hops.length, segments.length - 1, '跳数与网段数对应');
  evidence.hops.forEach((hop, i) => {
    assert.equal(hop.source, segments[i]!);
    assert.equal(hop.destination, segments[i + 1]!);
    const decision = matcher.decide(hop.source, hop.destination, protocol, port);
    assert.ok(decision.allowed, `第 ${i} 跳应可通行`);
    assert.equal(decision.winningAction, hop.action);
    assert.equal(decision.winningPriority, hop.priority);
    assert.notEqual(hop.action, 'Deny');
  });
}

function evidenceFor(result: { ports: readonly number[]; evidence: readonly { port: number; evidence: CycleEvidence }[] }, port: number): CycleEvidence {
  const found = result.evidence.find((e) => e.port === port);
  assert.ok(found, `端口 ${port} 应有证据`);
  return found.evidence;
}

test('TCP 基本闭环：返回闭环端口并附可逐跳核验的证据', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 443, end: 443 } },
    { source: 'B', destination: 'C', protocol: 'TCP', action: 'Log-and-Allow', priority: 1, portRange: { start: 443, end: 443 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 443, end: 443 } },
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, [443]);
  verifyEvidence(policies, evidenceFor(result.tcp, 443), 'TCP', 443);
  assert.equal(result.udp.ports.length, 0);
  assert.equal(result.icmp.hasCycle, false);
});

test('高优先级 Deny 把允许闭环截成两段：被截端口闭环消失，其余端口仍在', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 81 } },
    { source: 'B', destination: 'C', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 81 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 10, portRange: { start: 0, end: 65535 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Deny', priority: 5, portRange: { start: 80, end: 80 } },
  ];
  const result = analyzePolicies(policies);
  assert.ok(!result.tcp.ports.includes(80), '端口 80 的闭环应被 Deny 截断');
  assert.ok(result.tcp.ports.includes(81), '端口 81 的闭环应保留');
  verifyEvidence(policies, evidenceFor(result.tcp, 81), 'TCP', 81);
});

test('胜出的 Deny 不被低优先级 Allow 补位', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Deny', priority: 1, portRange: { start: 80, end: 80 } },
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 2, portRange: { start: 80, end: 80 } },
    { source: 'B', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
  ];
  const matcher = createMatcher(policies);
  assert.equal(matcher.decide('A', 'B', 'TCP', 80).allowed, false);
  assert.equal(analyzePolicies(policies).tcp.ports.length, 0);
});

test('网段连接形成环但各跳端口无法贯通，不算闭环', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
    { source: 'B', destination: 'C', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 8080, end: 8080 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
  ];
  assert.deepEqual(analyzePolicies(policies).tcp.ports, []);
});

test('网段连接形成环但协议不一致，不算闭环', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
    { source: 'B', destination: 'C', protocol: 'UDP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, []);
  assert.deepEqual(result.udp.ports, []);
});

test('UDP 与 TCP 独立判定：UDP 闭环只出现在 udp 结果中', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'UDP', action: 'Allow', priority: 1, portRange: { start: 53, end: 53 } },
    { source: 'B', destination: 'A', protocol: 'UDP', action: 'Allow', priority: 1, portRange: { start: 53, end: 53 } },
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.udp.ports, [53]);
  assert.deepEqual(result.tcp.ports, []);
  verifyEvidence(policies, evidenceFor(result.udp, 53), 'UDP', 53);
});

test('两个网段的往返即构成闭环；单向不构成', () => {
  const bidirectional: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 22, end: 22 } },
    { source: 'B', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 22, end: 22 } },
  ];
  const result = analyzePolicies(bidirectional);
  assert.deepEqual(result.tcp.ports, [22]);
  verifyEvidence(bidirectional, evidenceFor(result.tcp, 22), 'TCP', 22);

  const oneWay: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 22, end: 22 } },
  ];
  assert.deepEqual(analyzePolicies(oneWay).tcp.ports, []);
});

test('反方向需要单独判定：正向放行、反向无策略时不构成闭环', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 0, end: 65535 } },
    { source: 'B', destination: 'C', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 0, end: 65535 } },
    { source: 'C', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 0, end: 65535 } },
    // C→A 反向（A→C）无策略，默认拒绝；上面是单向环，这里验证反方向不自动成立。
  ];
  const matcher = createMatcher(policies);
  assert.equal(matcher.decide('A', 'C', 'TCP', 80).allowed, false, '无匹配策略默认拒绝');
  assert.equal(matcher.decide('C', 'A', 'TCP', 80).allowed, true);
});

test('ICMP 闭环：返回存在性并附可逐跳核验的证据', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'ICMP', action: 'Allow', priority: 1 },
    { source: 'B', destination: 'C', protocol: 'ICMP', action: 'Log-and-Allow', priority: 1 },
    { source: 'C', destination: 'A', protocol: 'ICMP', action: 'Allow', priority: 1 },
  ];
  const result = analyzePolicies(policies);
  assert.equal(result.icmp.hasCycle, true);
  const evidence = result.icmp.evidence;
  if (evidence === null) {
    assert.fail('ICMP 闭环应附证据');
  }
  verifyEvidence(policies, evidence, 'ICMP', 0);
});

test('ICMP 环上高优先级 Deny 截断后不存在闭环', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'ICMP', action: 'Allow', priority: 1 },
    { source: 'B', destination: 'C', protocol: 'ICMP', action: 'Allow', priority: 1 },
    { source: 'C', destination: 'A', protocol: 'ICMP', action: 'Deny', priority: 1 },
    { source: 'C', destination: 'A', protocol: 'ICMP', action: 'Allow', priority: 2 },
  ];
  const result = analyzePolicies(policies);
  assert.equal(result.icmp.hasCycle, false);
  assert.equal(result.icmp.evidence, null);
});

test('闭环端口范围完整展开：连续区间内每个端口都列出', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 100, end: 102 } },
    { source: 'B', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 100, end: 102 } },
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, [100, 101, 102]);
  for (const port of result.tcp.ports) {
    verifyEvidence(policies, evidenceFor(result.tcp, port), 'TCP', port);
  }
});

test('输入校验：重复优先级、越界或倒置端口、非整数优先级均抛错', () => {
  const allow = (priority: number, start = 80, end = 80): Policy => ({
    source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority, portRange: { start, end },
  });
  assert.throws(() => analyzePolicies([allow(1), allow(1)]), /优先级重复/);
  assert.throws(() => analyzePolicies([allow(1, 81, 80)]), /端口范围/);
  assert.throws(() => analyzePolicies([allow(1, 0, 65536)]), /端口范围/);
  assert.throws(() => analyzePolicies([allow(1.5)]), /整数/);
  // 同一优先级用于不同网段对或不同协议是合法的。
  assert.doesNotThrow(() =>
    analyzePolicies([
      allow(1),
      { source: 'B', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
      { source: 'A', destination: 'B', protocol: 'UDP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
    ]),
  );
});

test('分析不修改调用方传入的策略集', () => {
  const policies: Policy[] = [
    { source: 'A', destination: 'B', protocol: 'TCP', action: 'Allow', priority: 2, portRange: { start: 80, end: 80 } },
    { source: 'B', destination: 'A', protocol: 'TCP', action: 'Allow', priority: 1, portRange: { start: 80, end: 80 } },
  ];
  const snapshot = JSON.parse(JSON.stringify(policies));
  analyzePolicies(policies);
  assert.deepEqual(policies, snapshot);
});

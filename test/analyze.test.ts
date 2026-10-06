import assert from "node:assert/strict";
import test from "node:test";
import { analyzePolicies } from "../src/analyze.js";
import { isAllowed, isIcmpAllowed } from "../src/matcher.js";
import type { CycleEvidence, Policy, TcpUdpPolicy } from "../src/types.js";

function tcp(
  source: string,
  target: string,
  action: TcpUdpPolicy["action"],
  priority: number,
  min: number,
  max: number,
): TcpUdpPolicy {
  return { source, target, protocol: "TCP", action, priority, portRange: { min, max } };
}

function udp(
  source: string,
  target: string,
  action: TcpUdpPolicy["action"],
  priority: number,
  min: number,
  max: number,
): TcpUdpPolicy {
  return { source, target, protocol: "UDP", action, priority, portRange: { min, max } };
}

/** 逐跳核验证据：每跳都被策略允许，依次衔接、返回起点、除首尾外网段不重复。 */
function verifyEvidence(policies: readonly Policy[], evidence: CycleEvidence): void {
  const hops = evidence.hops;
  assert.ok(hops.length >= 2, "闭环至少经过两个不同网段");
  const nodes = hops.map((h) => h.source);
  assert.equal(new Set(nodes).size, nodes.length, "除首尾外网段不重复");
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    assert.equal(hop.target, hops[(i + 1) % hops.length]!.source, "跳与跳依次衔接");
    if (evidence.protocol === "ICMP") {
      assert.ok(isIcmpAllowed(policies, hop.source, hop.target), `ICMP ${hop.source}->${hop.target} 应允许`);
    } else {
      assert.ok(
        isAllowed(policies, hop.source, hop.target, evidence.protocol, evidence.port!),
        `${evidence.protocol}:${evidence.port} ${hop.source}->${hop.target} 应允许`,
      );
    }
  }
}

test("高优先级拒绝规则把允许闭环截成两段", () => {
  // a->b->c->a 在 TCP:80 上本可成环，但 b->c 的高优先级 Deny 截断该端口。
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 80, 80),
    tcp("b", "c", "Allow", 5, 1, 1000),
    tcp("b", "c", "Deny", 1, 80, 80),
    tcp("c", "a", "Allow", 1, 80, 80),
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, [], "TCP:80 的闭环被 Deny 截断");

  // 同一组策略下，TCP:443 不受 Deny 影响，闭环仍然成立。
  const with443: Policy[] = [
    ...policies,
    tcp("a", "b", "Allow", 2, 443, 443),
    tcp("c", "a", "Allow", 2, 443, 443),
  ];
  const result443 = analyzePolicies(with443);
  assert.deepEqual(result443.tcp.ports, [443]);
  verifyEvidence(with443, result443.tcp.evidence.get(443)!);
});

test("网段连接形成环但协议无法贯通，不算闭环", () => {
  // 拓扑上 a->b->c->a 成环，但三条边协议不同，任何单一协议都不成环。
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 80, 80),
    udp("b", "c", "Allow", 1, 80, 80),
    tcp("c", "a", "Allow", 1, 80, 80),
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, []);
  assert.deepEqual(result.udp.ports, []);
});

test("各跳只能用不同端口通行时，不算闭环", () => {
  // 拓扑成环且都是 TCP，但同一目的端口无法贯穿每一跳。
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 80, 80),
    tcp("b", "c", "Allow", 1, 443, 443),
    tcp("c", "a", "Allow", 1, 80, 80),
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, []);
});

test("返回所有存在闭环的端口，且证据可逐跳核验", () => {
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 8000, 8002),
    tcp("b", "c", "Log-and-Allow", 1, 8000, 8002),
    tcp("c", "a", "Allow", 1, 8000, 8002),
    udp("a", "b", "Allow", 1, 53, 53),
    udp("b", "a", "Allow", 1, 53, 53),
  ];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, [8000, 8001, 8002]);
  assert.deepEqual(result.udp.ports, [53]);
  for (const port of result.tcp.ports) verifyEvidence(policies, result.tcp.evidence.get(port)!);
  verifyEvidence(policies, result.udp.evidence.get(53)!);
});

test("ICMP 闭环返回存在性与可核验证据", () => {
  const policies: Policy[] = [
    { source: "a", target: "b", protocol: "ICMP", action: "Allow", priority: 1 },
    { source: "b", target: "c", protocol: "ICMP", action: "Log-and-Allow", priority: 1 },
    { source: "c", target: "a", protocol: "ICMP", action: "Allow", priority: 1 },
  ];
  const result = analyzePolicies(policies);
  assert.equal(result.icmp.hasCycle, true);
  verifyEvidence(policies, result.icmp.evidence!);
});

test("ICMP 有一跳被拒绝则无闭环", () => {
  const policies: Policy[] = [
    { source: "a", target: "b", protocol: "ICMP", action: "Allow", priority: 1 },
    { source: "b", target: "c", protocol: "ICMP", action: "Deny", priority: 1 },
    { source: "b", target: "c", protocol: "ICMP", action: "Allow", priority: 2 },
    { source: "c", target: "a", protocol: "ICMP", action: "Allow", priority: 1 },
  ];
  const result = analyzePolicies(policies);
  assert.equal(result.icmp.hasCycle, false);
  assert.equal(result.icmp.evidence, undefined);
});

test("自环策略不构成闭环", () => {
  const policies: Policy[] = [tcp("a", "a", "Allow", 1, 80, 80)];
  const result = analyzePolicies(policies);
  assert.deepEqual(result.tcp.ports, []);
});

test("空策略集无任何闭环", () => {
  const result = analyzePolicies([]);
  assert.deepEqual(result.tcp.ports, []);
  assert.deepEqual(result.udp.ports, []);
  assert.equal(result.icmp.hasCycle, false);
});

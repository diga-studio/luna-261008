import assert from "node:assert/strict";
import test from "node:test";
import { allowedPortRanges, isAllowed, isIcmpAllowed } from "../src/matcher.js";
import type { Policy, TcpUdpPolicy } from "../src/types.js";

function tcp(source: string, target: string, action: TcpUdpPolicy["action"], priority: number, min: number, max: number): TcpUdpPolicy {
  return { source, target, protocol: "TCP", action, priority, portRange: { min, max } };
}

test("无匹配策略时拒绝通行", () => {
  const policies: Policy[] = [];
  assert.equal(isAllowed(policies, "a", "b", "TCP", 80), false);
  assert.deepEqual(allowedPortRanges(policies, "a", "b", "TCP"), []);
});

test("Allow 与 Log-and-Allow 均允许通行", () => {
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 80, 80),
    tcp("a", "c", "Log-and-Allow", 1, 443, 443),
  ];
  assert.equal(isAllowed(policies, "a", "b", "TCP", 80), true);
  assert.equal(isAllowed(policies, "a", "c", "TCP", 443), true);
});

test("优先级数值最小者生效，Deny 胜出时低优先级 Allow 不补位", () => {
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 10, 1, 1000),
    tcp("a", "b", "Deny", 5, 80, 80),
  ];
  assert.equal(isAllowed(policies, "a", "b", "TCP", 80), false);
  assert.equal(isAllowed(policies, "a", "b", "TCP", 79), true);
  assert.equal(isAllowed(policies, "a", "b", "TCP", 81), true);
  assert.deepEqual(allowedPortRanges(policies, "a", "b", "TCP"), [
    { min: 1, max: 79 },
    { min: 81, max: 1000 },
  ]);
});

test("高优先级 Allow 不会被低优先级 Deny 覆盖", () => {
  const policies: Policy[] = [
    tcp("a", "b", "Allow", 1, 80, 80),
    tcp("a", "b", "Deny", 2, 1, 1000),
  ];
  assert.equal(isAllowed(policies, "a", "b", "TCP", 80), true);
  assert.equal(isAllowed(policies, "a", "b", "TCP", 81), false);
});

test("反方向需要单独判定", () => {
  const policies: Policy[] = [tcp("a", "b", "Allow", 1, 80, 80)];
  assert.equal(isAllowed(policies, "a", "b", "TCP", 80), true);
  assert.equal(isAllowed(policies, "b", "a", "TCP", 80), false);
});

test("协议之间互不影响", () => {
  const policies: Policy[] = [tcp("a", "b", "Allow", 1, 80, 80)];
  assert.equal(isAllowed(policies, "a", "b", "UDP", 80), false);
});

test("ICMP 无端口条件，按优先级判定", () => {
  const allow: Policy[] = [{ source: "a", target: "b", protocol: "ICMP", action: "Log-and-Allow", priority: 1 }];
  assert.equal(isIcmpAllowed(allow, "a", "b"), true);
  const denyWins: Policy[] = [
    { source: "a", target: "b", protocol: "ICMP", action: "Allow", priority: 2 },
    { source: "a", target: "b", protocol: "ICMP", action: "Deny", priority: 1 },
  ];
  assert.equal(isIcmpAllowed(denyWins, "a", "b"), false);
  assert.equal(isIcmpAllowed([], "a", "b"), false);
});

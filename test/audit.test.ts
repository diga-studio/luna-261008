import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyAuditor } from "../src/index.js";
import type { Connection, FirewallRule } from "../src/index.js";

function rule(partial: Partial<FirewallRule> & { id: string }): FirewallRule {
  return {
    priority: 100,
    direction: "in",
    protocol: "any",
    sourceCidr: "0.0.0.0/0",
    destinationCidr: "0.0.0.0/0",
    action: "allow",
    ...partial,
  };
}

test("multiple earlier rules jointly shadow a later rule", () => {
  const rules = [
    rule({ id: "low", priority: 10, protocol: "tcp", portRange: { start: 0, end: 1024 } }),
    rule({ id: "high", priority: 10, protocol: "tcp", portRange: { start: 1025, end: 65535 } }),
    rule({ id: "udp-all", priority: 20, protocol: "udp", portRange: { start: 0, end: 65535 } }),
    rule({ id: "icmp-all", priority: 30, protocol: "icmp" }),
    rule({ id: "victim", priority: 40, protocol: "any", action: "deny" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("victim")!.status, "shadowed");
  assert.equal(verdicts.get("low")!.status, "reachable");
  assert.equal(verdicts.get("high")!.status, "reachable");
  assert.equal(verdicts.get("udp-all")!.status, "reachable");
  assert.equal(verdicts.get("icmp-all")!.status, "reachable");
});

test("no single earlier rule covers the victim, yet it is shadowed", () => {
  const rules = [
    rule({ id: "src-half", priority: 1, sourceCidr: "10.0.0.0/9" }),
    rule({ id: "dst-half", priority: 2, destinationCidr: "0.0.0.0/1" }),
    rule({ id: "victim", priority: 3, sourceCidr: "10.0.0.0/8", destinationCidr: "0.0.0.0/1" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("victim")!.status, "shadowed");
});

test("exactly one remaining connection combination yields a precise witness", () => {
  const rules = [
    rule({ id: "before", priority: 1, protocol: "tcp", portRange: { start: 0, end: 65534 } }),
    rule({
      id: "victim",
      priority: 2,
      protocol: "tcp",
      sourceCidr: "10.0.0.1/32",
      destinationCidr: "10.0.0.2/32",
      portRange: { start: 0, end: 65535 },
    }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  const victim = verdicts.get("victim")!;
  assert.equal(victim.status, "reachable");
  assert.deepEqual(victim.witness, {
    direction: "in",
    protocol: "tcp",
    sourceAddress: "10.0.0.1",
    destinationAddress: "10.0.0.2",
    destinationPort: 65535,
  });
});

test("same priority falls back to input order", () => {
  const rules = [
    rule({ id: "first", priority: 50, action: "deny" }),
    rule({ id: "second", priority: 50, action: "allow" }),
  ];
  const auditor = new PolicyAuditor(rules);
  const conn: Connection = {
    direction: "in",
    protocol: "tcp",
    sourceAddress: "1.2.3.4",
    destinationAddress: "5.6.7.8",
    destinationPort: 443,
  };
  assert.deepEqual(auditor.evaluate(conn), { ruleId: "first", action: "deny" });
  const report = auditor.audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("first")!.status, "reachable");
  assert.equal(verdicts.get("second")!.status, "shadowed");
});

test("rules in the opposite direction never shadow", () => {
  const rules = [
    rule({ id: "out-all", priority: 1, direction: "out" }),
    rule({ id: "in-rule", priority: 2, direction: "in" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("in-rule")!.status, "reachable");
});

test("tcp rule does not shadow udp or icmp traffic", () => {
  const rules = [
    rule({ id: "tcp-all", priority: 1, protocol: "tcp", portRange: { start: 0, end: 65535 } }),
    rule({ id: "udp-rule", priority: 2, protocol: "udp", portRange: { start: 53, end: 53 } }),
    rule({ id: "icmp-rule", priority: 3, protocol: "icmp" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("udp-rule")!.status, "reachable");
  assert.equal(verdicts.get("udp-rule")!.witness!.destinationPort, 53);
  assert.equal(verdicts.get("icmp-rule")!.status, "reachable");
  assert.equal(verdicts.get("icmp-rule")!.witness!.destinationPort, undefined);
});

test("any-protocol rule shadows all concrete protocols", () => {
  const rules = [
    rule({ id: "any-all", priority: 1 }),
    rule({ id: "tcp-later", priority: 2, protocol: "tcp", portRange: { start: 80, end: 80 } }),
    rule({ id: "udp-later", priority: 3, protocol: "udp", portRange: { start: 53, end: 53 } }),
    rule({ id: "icmp-later", priority: 4, protocol: "icmp" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  for (const v of report.verdicts) {
    if (v.ruleId === "any-all") {
      assert.equal(v.status, "reachable");
    } else {
      assert.equal(v.status, "shadowed", v.ruleId);
    }
  }
});

test("IPv4 and IPv6 rules never shadow each other", () => {
  const rules = [
    rule({ id: "v4-all", priority: 1, sourceCidr: "0.0.0.0/0", destinationCidr: "0.0.0.0/0" }),
    rule({ id: "v6-rule", priority: 2, sourceCidr: "::/0", destinationCidr: "::/0" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("v6-rule")!.status, "reachable");
});

test("IPv6 full-range shadowing across the whole 128-bit space", () => {
  const rules = [
    rule({ id: "v6-low", priority: 1, sourceCidr: "::/1", destinationCidr: "::/0" }),
    rule({ id: "v6-high", priority: 2, sourceCidr: "8000::/1", destinationCidr: "::/0" }),
    rule({ id: "v6-victim", priority: 3, sourceCidr: "::/0", destinationCidr: "::/0" }),
  ];
  const report = new PolicyAuditor(rules).audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("v6-victim")!.status, "shadowed");
});

test("single IPv6 address and port combination stays reachable", () => {
  const rules = [
    rule({
      id: "almost-all",
      priority: 1,
      protocol: "udp",
      sourceCidr: "::/0",
      destinationCidr: "::/0",
      portRange: { start: 1, end: 65535 },
    }),
    rule({
      id: "victim",
      priority: 2,
      protocol: "udp",
      sourceCidr: "2001:db8::1/128",
      destinationCidr: "2001:db8::2/128",
      portRange: { start: 0, end: 0 },
    }),
  ];
  const auditor = new PolicyAuditor(rules);
  const report = auditor.audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  const victim = verdicts.get("victim")!;
  assert.equal(victim.status, "reachable");
  assert.deepEqual(victim.witness, {
    direction: "in",
    protocol: "udp",
    sourceAddress: "2001:db8::1",
    destinationAddress: "2001:db8::2",
    destinationPort: 0,
  });
  assert.deepEqual(auditor.evaluate(victim.witness!), { ruleId: "victim", action: "allow" });
});

test("evaluate returns first match and stops at log action", () => {
  const rules = [
    rule({ id: "logger", priority: 1, action: "log" }),
    rule({ id: "allow-all", priority: 2, action: "allow" }),
  ];
  const auditor = new PolicyAuditor(rules);
  const conn: Connection = {
    direction: "in",
    protocol: "icmp",
    sourceAddress: "1.2.3.4",
    destinationAddress: "5.6.7.8",
  };
  assert.deepEqual(auditor.evaluate(conn), { ruleId: "logger", action: "log" });
});

test("evaluate defaults to deny when nothing matches", () => {
  const rules = [
    rule({ id: "narrow", priority: 1, protocol: "tcp", sourceCidr: "10.0.0.0/8", portRange: { start: 22, end: 22 } }),
  ];
  const auditor = new PolicyAuditor(rules);
  const conn: Connection = {
    direction: "in",
    protocol: "tcp",
    sourceAddress: "11.0.0.1",
    destinationAddress: "10.0.0.1",
    destinationPort: 22,
  };
  assert.deepEqual(auditor.evaluate(conn), { ruleId: null, action: "deny" });
});

test("policies over 500 rules are rejected", () => {
  const rules = Array.from({ length: 501 }, (_, i) => rule({ id: `r${i}` }));
  assert.throws(() => new PolicyAuditor(rules));
});

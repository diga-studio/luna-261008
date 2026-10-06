import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyAuditor } from "../src/index.js";
import type { Connection, FirewallRule } from "../src/index.js";

const SRC_NET = "10.0.0.0/30";
const DST_NET = "10.0.0.4/30";
const SRC_HOSTS = ["10.0.0.0", "10.0.0.1", "10.0.0.2", "10.0.0.3"];
const DST_HOSTS = ["10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7"];

function tcpRule(
  id: string,
  priority: number,
  start: number,
  end: number,
  action: FirewallRule["action"],
  extra: Partial<FirewallRule> = {},
): FirewallRule {
  return {
    id,
    priority,
    direction: "in",
    protocol: "tcp",
    sourceCidr: SRC_NET,
    destinationCidr: DST_NET,
    action,
    portRange: { start, end },
    ...extra,
  };
}

function buildPolicy(): FirewallRule[] {
  return [
    tcpRule("deny-web", 10, 80, 80, "deny"),
    tcpRule("log-low", 20, 0, 1023, "log"),
    tcpRule("joint-a", 40, 1024, 40000, "deny"),
    tcpRule("joint-b", 50, 40001, 65535, "deny"),
    tcpRule("joint-victim", 60, 1024, 65535, "allow"),
    {
      id: "allow-udp-dns",
      priority: 30,
      direction: "in",
      protocol: "udp",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "allow",
      portRange: { start: 53, end: 53 },
    },
    {
      id: "edge",
      priority: 70,
      direction: "in",
      protocol: "udp",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "deny",
      portRange: { start: 0, end: 65534 },
    },
    {
      id: "edge-victim",
      priority: 80,
      direction: "in",
      protocol: "udp",
      sourceCidr: "10.0.0.1/32",
      destinationCidr: "10.0.0.5/32",
      action: "allow",
      portRange: { start: 0, end: 65535 },
    },
    {
      id: "icmp-all",
      priority: 90,
      direction: "in",
      protocol: "icmp",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "allow",
    },
    {
      id: "icmp-shadow",
      priority: 95,
      direction: "in",
      protocol: "icmp",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "deny",
    },
    {
      id: "any-victim",
      priority: 100,
      direction: "in",
      protocol: "any",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "deny",
    },
    {
      id: "out-rule",
      priority: 5,
      direction: "out",
      protocol: "any",
      sourceCidr: SRC_NET,
      destinationCidr: DST_NET,
      action: "deny",
    },
  ];
}

test("exhaustive connection scan matches audit verdicts", () => {
  const auditor = new PolicyAuditor(buildPolicy());
  const report = auditor.audit();
  const verdictById = new Map(report.verdicts.map((v) => [v.ruleId, v]));

  assert.equal(verdictById.get("joint-victim")!.status, "shadowed");
  assert.equal(verdictById.get("icmp-shadow")!.status, "shadowed");
  assert.equal(verdictById.get("edge-victim")!.status, "reachable");
  assert.equal(verdictById.get("any-victim")!.status, "reachable");

  const hitByEnum = new Set<string>();
  for (const src of SRC_HOSTS) {
    for (const dst of DST_HOSTS) {
      for (let port = 0; port <= 65535; port++) {
        for (const protocol of ["tcp", "udp"] as const) {
          const conn: Connection = {
            direction: "in",
            protocol,
            sourceAddress: src,
            destinationAddress: dst,
            destinationPort: port,
          };
          const res = auditor.evaluate(conn);
          if (res.ruleId !== null) {
            hitByEnum.add(res.ruleId);
          }
        }
      }
      const icmpConn: Connection = {
        direction: "in",
        protocol: "icmp",
        sourceAddress: src,
        destinationAddress: dst,
      };
      const res = auditor.evaluate(icmpConn);
      if (res.ruleId !== null) {
        hitByEnum.add(res.ruleId);
      }
    }
  }

  const reachableInDirection = report.verdicts
    .filter((v) => v.status === "reachable" && v.ruleId !== "out-rule")
    .map((v) => v.ruleId);
  assert.deepEqual(
    [...hitByEnum].sort(),
    [...reachableInDirection].sort(),
    "enumerated first-hit rule set must equal the reachable verdict set",
  );

  for (const verdict of report.verdicts) {
    if (verdict.status !== "reachable") continue;
    const res = auditor.evaluate(verdict.witness!);
    assert.equal(
      res.ruleId,
      verdict.ruleId,
      `witness of ${verdict.ruleId} must first-hit that rule`,
    );
  }

  const edgeVictim = verdictById.get("edge-victim")!;
  assert.equal(edgeVictim.witness!.destinationPort, 65535);
  assert.equal(edgeVictim.witness!.sourceAddress, "10.0.0.1");
  assert.equal(edgeVictim.witness!.destinationAddress, "10.0.0.5");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PolicyAuditor } from "../src/index.js";
import type { Connection, FirewallRule } from "../src/index.js";
import { cidrToInterval, parseIp } from "../src/ip.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomV4Cidr(rand: () => number): string {
  const a = Math.floor(rand() * 256);
  const b = Math.floor(rand() * 256);
  const c = Math.floor(rand() * 256);
  const d = Math.floor(rand() * 256);
  const prefix = 8 + Math.floor(rand() * 25);
  return `${a}.${b}.${c}.${d}/${prefix}`;
}

function randomV6Cidr(rand: () => number): string {
  const groups = Array.from({ length: 4 }, () =>
    Math.floor(rand() * 65536).toString(16),
  );
  const prefix = 32 + Math.floor(rand() * 97);
  return `${groups.join(":")}::/${prefix}`;
}

function generatePolicy(seed: number, size: number): FirewallRule[] {
  const rand = mulberry32(seed);
  const protocols = ["tcp", "udp", "icmp", "any"] as const;
  const actions = ["allow", "deny", "log"] as const;
  const rules: FirewallRule[] = [];
  for (let i = 0; i < size; i++) {
    const v4 = rand() < 0.5;
    const protocol = protocols[Math.floor(rand() * protocols.length)]!;
    const rule: FirewallRule = {
      id: `rule-${i}`,
      priority: 1 + Math.floor(rand() * 1000),
      direction: rand() < 0.5 ? "in" : "out",
      protocol,
      sourceCidr: v4 ? randomV4Cidr(rand) : randomV6Cidr(rand),
      destinationCidr: v4 ? randomV4Cidr(rand) : randomV6Cidr(rand),
      action: actions[Math.floor(rand() * actions.length)]!,
    };
    if (protocol === "tcp" || protocol === "udp") {
      const start = Math.floor(rand() * 65536);
      const end = start + Math.floor(rand() * (65536 - start));
      rule.portRange = { start, end };
    }
    rules.push(rule);
  }
  return rules;
}

function referenceEvaluate(
  rules: FirewallRule[],
  conn: Connection,
): string | null {
  const src = parseIp(conn.sourceAddress);
  const dst = parseIp(conn.destinationAddress);
  const order = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index);
  for (const { rule } of order) {
    if (rule.direction !== conn.direction) continue;
    if (rule.protocol !== "any" && rule.protocol !== conn.protocol) continue;
    const srcIv = cidrToInterval(rule.sourceCidr);
    const dstIv = cidrToInterval(rule.destinationCidr);
    if (src.family !== srcIv.family || dst.family !== dstIv.family) continue;
    if (src.value < srcIv.lo || src.value > srcIv.hi) continue;
    if (dst.value < dstIv.lo || dst.value > dstIv.hi) continue;
    if (rule.protocol === "tcp" || rule.protocol === "udp") {
      const port = conn.destinationPort;
      const range = rule.portRange ?? { start: 0, end: 65535 };
      if (port === undefined || port < range.start || port > range.end) {
        continue;
      }
    }
    return rule.id;
  }
  return null;
}

test("500 mixed-family rules: time, memory, order semantics, witnesses", () => {
  const rules = generatePolicy(20261006, 500);
  assert.equal(rules.length, 500);
  globalThis.gc?.();
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const auditor = new PolicyAuditor(rules);
  const report = auditor.audit();
  const elapsedMs = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  const memDeltaMiB = (memAfter - memBefore) / (1024 * 1024);
  assert.equal(report.verdicts.length, 500);
  assert.ok(
    elapsedMs < 15_000,
    `audit took ${elapsedMs.toFixed(0)}ms, expected < 15000ms`,
  );
  assert.ok(
    memDeltaMiB < 256,
    `heap grew ${memDeltaMiB.toFixed(1)} MiB, expected < 256 MiB`,
  );
  const reachable = report.verdicts.filter((v) => v.status === "reachable");
  assert.ok(reachable.length > 0);
  for (const verdict of reachable) {
    const res = auditor.evaluate(verdict.witness!);
    assert.equal(
      res.ruleId,
      verdict.ruleId,
      `witness of ${verdict.ruleId} must first-hit that rule`,
    );
  }
  const rand = mulberry32(777);
  for (let i = 0; i < 300; i++) {
    const v4 = rand() < 0.5;
    const protocol = ["tcp", "udp", "icmp"][Math.floor(rand() * 3)]!;
    const conn: Connection = {
      direction: rand() < 0.5 ? "in" : "out",
      protocol: protocol as Connection["protocol"],
      sourceAddress: v4
        ? `${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`
        : `${Math.floor(rand() * 65536).toString(16)}:${Math.floor(rand() * 65536).toString(16)}::${Math.floor(rand() * 65536).toString(16)}`,
      destinationAddress: v4
        ? `${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`
        : `${Math.floor(rand() * 65536).toString(16)}:${Math.floor(rand() * 65536).toString(16)}::${Math.floor(rand() * 65536).toString(16)}`,
    };
    if (protocol !== "icmp") {
      conn.destinationPort = Math.floor(rand() * 65536);
    }
    const expected = referenceEvaluate(rules, conn);
    const actual = auditor.evaluate(conn);
    assert.equal(
      actual.ruleId,
      expected,
      `evaluate mismatch for ${JSON.stringify(conn)}`,
    );
    if (expected === null) {
      assert.equal(actual.action, "deny");
    }
  }
  console.log(
    `scale: 500 rules audited in ${elapsedMs.toFixed(0)}ms, heap +${memDeltaMiB.toFixed(1)} MiB, reachable ${reachable.length}/500`,
  );
});

test("same-priority ordering is respected at scale", () => {
  const rules: FirewallRule[] = [];
  for (let i = 0; i < 500; i++) {
    rules.push({
      id: `same-${i}`,
      priority: 500,
      direction: "in",
      protocol: "any",
      sourceCidr: i % 2 === 0 ? "0.0.0.0/0" : "::/0",
      destinationCidr: i % 2 === 0 ? "0.0.0.0/0" : "::/0",
      action: i % 2 === 0 ? "deny" : "allow",
    });
  }
  const auditor = new PolicyAuditor(rules);
  const v4Conn: Connection = {
    direction: "in",
    protocol: "tcp",
    sourceAddress: "1.2.3.4",
    destinationAddress: "5.6.7.8",
    destinationPort: 1,
  };
  const v6Conn: Connection = {
    direction: "in",
    protocol: "tcp",
    sourceAddress: "::1",
    destinationAddress: "::2",
    destinationPort: 1,
  };
  assert.deepEqual(auditor.evaluate(v4Conn), {
    ruleId: "same-0",
    action: "deny",
  });
  assert.deepEqual(auditor.evaluate(v6Conn), {
    ruleId: "same-1",
    action: "allow",
  });
  const report = auditor.audit();
  const verdicts = new Map(report.verdicts.map((v) => [v.ruleId, v]));
  assert.equal(verdicts.get("same-0")!.status, "reachable");
  assert.equal(verdicts.get("same-1")!.status, "reachable");
  assert.equal(verdicts.get("same-2")!.status, "shadowed");
  assert.equal(verdicts.get("same-3")!.status, "shadowed");
});

test("500 heavily overlapping rules stay within time and memory limits", () => {
  const rand = mulberry32(424242);
  const rules: FirewallRule[] = [];
  for (let i = 0; i < 500; i++) {
    const srcThird = Math.floor(rand() * 3);
    const dstThird = Math.floor(rand() * 3);
    const start = Math.floor(rand() * 65536);
    const end = Math.min(65535, start + Math.floor(rand() * 20000));
    rules.push({
      id: `ovl-${i}`,
      priority: 1 + Math.floor(rand() * 50),
      direction: "in",
      protocol: i % 4 === 3 ? "udp" : "tcp",
      sourceCidr: `10.${srcThird * 64}.0.0/10`,
      destinationCidr: `172.${16 + dstThird * 4}.0.0/14`,
      action: i % 3 === 0 ? "deny" : "allow",
      portRange: { start, end },
    });
  }
  globalThis.gc?.();
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const auditor = new PolicyAuditor(rules);
  const report = auditor.audit();
  const elapsedMs = performance.now() - start;
  const memDeltaMiB =
    (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024);
  const shadowed = report.verdicts.filter((v) => v.status === "shadowed");
  assert.ok(
    elapsedMs < 15_000,
    `overlapping audit took ${elapsedMs.toFixed(0)}ms, expected < 15000ms`,
  );
  assert.ok(
    memDeltaMiB < 256,
    `heap grew ${memDeltaMiB.toFixed(1)} MiB, expected < 256 MiB`,
  );
  for (const verdict of report.verdicts) {
    if (verdict.status !== "reachable") continue;
    const res = auditor.evaluate(verdict.witness!);
    assert.equal(res.ruleId, verdict.ruleId);
  }
  console.log(
    `overlap: 500 rules audited in ${elapsedMs.toFixed(0)}ms, heap +${memDeltaMiB.toFixed(1)} MiB, shadowed ${shadowed.length}/500`,
  );
});

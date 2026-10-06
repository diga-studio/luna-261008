import type {
  Action,
  AuditReport,
  Connection,
  ConcreteProtocol,
  EvalResult,
  FirewallRule,
  RuleVerdict,
} from "./model.js";
import { cidrToInterval, formatIp, parseIp } from "./ip.js";
import type { AddressFamily, CidrInterval } from "./ip.js";
import { subtractBoxFromAll } from "./rect.js";
import type { Rect } from "./rect.js";

const MAX_RULES = 500;
const PORT_MIN = 0n;
const PORT_MAX = 65535n;

interface CompiledRule {
  id: string;
  action: Action;
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "any";
  src: CidrInterval;
  dst: CidrInterval;
  portLo: bigint;
  portHi: bigint;
}

function concreteProtocols(
  protocol: "tcp" | "udp" | "icmp" | "any",
): ConcreteProtocol[] {
  if (protocol === "any") {
    return ["tcp", "udp", "icmp"];
  }
  return [protocol];
}

function ruleMatchesProtocol(
  ruleProtocol: "tcp" | "udp" | "icmp" | "any",
  connProtocol: ConcreteProtocol,
): boolean {
  return ruleProtocol === "any" || ruleProtocol === connProtocol;
}

function compileRule(rule: FirewallRule): CompiledRule {
  const src = cidrToInterval(rule.sourceCidr);
  const dst = cidrToInterval(rule.destinationCidr);
  if (src.family !== dst.family) {
    throw new Error(
      `rule ${rule.id}: source and destination CIDR families differ`,
    );
  }
  let portLo = PORT_MIN;
  let portHi = PORT_MAX;
  if (rule.protocol === "tcp" || rule.protocol === "udp") {
    const range = rule.portRange ?? { start: 0, end: 65535 };
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end > 65535 ||
      range.start > range.end
    ) {
      throw new Error(`rule ${rule.id}: invalid port range`);
    }
    portLo = BigInt(range.start);
    portHi = BigInt(range.end);
  }
  return {
    id: rule.id,
    action: rule.action,
    direction: rule.direction,
    protocol: rule.protocol,
    src,
    dst,
    portLo,
    portHi,
  };
}

function boxFor(rule: CompiledRule, hasPortDim: boolean): Rect {
  const rect: Rect = [
    { lo: rule.src.lo, hi: rule.src.hi },
    { lo: rule.dst.lo, hi: rule.dst.hi },
  ];
  if (hasPortDim) {
    rect.push({ lo: rule.portLo, hi: rule.portHi });
  }
  return rect;
}

export class PolicyAuditor {
  private readonly ordered: CompiledRule[];

  constructor(rules: FirewallRule[]) {
    if (rules.length > MAX_RULES) {
      throw new Error(`policy exceeds ${MAX_RULES} rules`);
    }
    const compiled = rules.map((rule, index) => ({
      compiled: compileRule(rule),
      priority: rule.priority,
      index,
    }));
    compiled.sort((a, b) => a.priority - b.priority || a.index - b.index);
    this.ordered = compiled.map((c) => c.compiled);
  }

  audit(): AuditReport {
    const verdicts: RuleVerdict[] = [];
    for (let i = 0; i < this.ordered.length; i++) {
      const rule = this.ordered[i]!;
      const earlier = this.ordered.slice(0, i);
      let witness: Connection | undefined;
      for (const proto of concreteProtocols(rule.protocol)) {
        const found = this.findWitness(rule, earlier, proto);
        if (found !== undefined) {
          witness = found;
          break;
        }
      }
      if (witness !== undefined) {
        verdicts.push({ ruleId: rule.id, status: "reachable", witness });
      } else {
        verdicts.push({ ruleId: rule.id, status: "shadowed" });
      }
    }
    return { verdicts };
  }

  private findWitness(
    rule: CompiledRule,
    earlier: CompiledRule[],
    proto: ConcreteProtocol,
  ): Connection | undefined {
    const hasPortDim = proto === "tcp" || proto === "udp";
    let regions: Rect[] = [boxFor(rule, hasPortDim)];
    for (const other of earlier) {
      if (other.direction !== rule.direction) continue;
      if (other.src.family !== rule.src.family) continue;
      if (!ruleMatchesProtocol(other.protocol, proto)) continue;
      regions = subtractBoxFromAll(regions, boxFor(other, hasPortDim));
      if (regions.length === 0) return undefined;
    }
    const rect = regions[0]!;
    const family: AddressFamily = rule.src.family;
    const conn: Connection = {
      direction: rule.direction,
      protocol: proto,
      sourceAddress: formatIp(family, rect[0]!.lo),
      destinationAddress: formatIp(family, rect[1]!.lo),
    };
    if (hasPortDim) {
      conn.destinationPort = Number(rect[2]!.lo);
    }
    return conn;
  }

  evaluate(conn: Connection): EvalResult {
    const src = parseIp(conn.sourceAddress);
    const dst = parseIp(conn.destinationAddress);
    for (const rule of this.ordered) {
      if (rule.direction !== conn.direction) continue;
      if (!ruleMatchesProtocol(rule.protocol, conn.protocol)) continue;
      if (src.family !== rule.src.family || dst.family !== rule.dst.family) {
        continue;
      }
      if (src.value < rule.src.lo || src.value > rule.src.hi) continue;
      if (dst.value < rule.dst.lo || dst.value > rule.dst.hi) continue;
      if (
        rule.protocol === "tcp" ||
        rule.protocol === "udp"
      ) {
        const port = conn.destinationPort;
        if (port === undefined) continue;
        const p = BigInt(port);
        if (p < rule.portLo || p > rule.portHi) continue;
      }
      return { ruleId: rule.id, action: rule.action };
    }
    return { ruleId: null, action: "deny" };
  }
}

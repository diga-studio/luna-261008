import { findCycle } from "./cycles.js";
import { allowedPortRanges, isIcmpAllowed } from "./matcher.js";
import type {
  AnalysisResult,
  CycleEvidence,
  Hop,
  Policy,
  PortProtocolResult,
  SegmentId,
} from "./types.js";

interface DirectedPair {
  readonly source: SegmentId;
  readonly target: SegmentId;
}

function collectPairs(policies: readonly Policy[], protocol: "TCP" | "UDP"): DirectedPair[] {
  const seen = new Set<string>();
  const pairs: DirectedPair[] = [];
  for (const p of policies) {
    if (p.protocol !== protocol) continue;
    const key = `${p.source}→${p.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ source: p.source, target: p.target });
  }
  return pairs;
}

function collectIcmpSegments(policies: readonly Policy[]): SegmentId[] {
  const segments = new Set<SegmentId>();
  for (const p of policies) {
    if (p.protocol !== "ICMP") continue;
    segments.add(p.source);
    segments.add(p.target);
  }
  return [...segments];
}

function analyzePortProtocol(policies: readonly Policy[], protocol: "TCP" | "UDP"): PortProtocolResult {
  const pairs = collectPairs(policies, protocol);
  // 每个有向网段对的允许端口区间集合。
  const edgeRanges = pairs.map((pair) => ({
    pair,
    ranges: allowedPortRanges(policies, pair.source, pair.target, protocol),
  }));

  // 图结构只会在区间边界处变化，按边界切出恒定区间逐段判定。
  const boundaries = new Set<number>();
  for (const { ranges } of edgeRanges) {
    for (const r of ranges) {
      boundaries.add(r.min);
      if (r.max < 65535) boundaries.add(r.max + 1);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const ports: number[] = [];
  const evidence = new Map<number, CycleEvidence>();

  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i]!;
    const hi = i + 1 < sorted.length ? sorted[i + 1]! - 1 : 65535;
    if (lo > hi) continue;
    const adjacency = new Map<SegmentId, SegmentId[]>();
    for (const { pair, ranges } of edgeRanges) {
      const open = ranges.some((r) => r.min <= lo && lo <= r.max);
      if (!open) continue;
      if (!adjacency.has(pair.source)) adjacency.set(pair.source, []);
      adjacency.get(pair.source)!.push(pair.target);
      if (!adjacency.has(pair.target)) adjacency.set(pair.target, []);
    }
    const hops = findCycle(adjacency);
    if (!hops) continue;
    for (let port = lo; port <= hi; port++) {
      ports.push(port);
      evidence.set(port, { protocol, port, hops });
    }
  }

  return { ports, evidence };
}

function analyzeIcmp(policies: readonly Policy[]): AnalysisResult["icmp"] {
  const segments = collectIcmpSegments(policies);
  const adjacency = new Map<SegmentId, SegmentId[]>();
  for (const s of segments) adjacency.set(s, []);
  for (const source of segments) {
    for (const target of segments) {
      if (source !== target && isIcmpAllowed(policies, source, target)) {
        adjacency.get(source)!.push(target);
      }
    }
  }
  const hops: Hop[] | undefined = findCycle(adjacency);
  if (!hops) return { hasCycle: false };
  return { hasCycle: true, evidence: { protocol: "ICMP", hops } };
}

/**
 * 对完整候选策略集做一次闭环分析。
 * 分析期间策略集不会被修改；输入仅保存在内存中。
 */
export function analyzePolicies(policies: readonly Policy[]): AnalysisResult {
  const snapshot = policies.slice();
  return {
    tcp: analyzePortProtocol(snapshot, "TCP"),
    udp: analyzePortProtocol(snapshot, "UDP"),
    icmp: analyzeIcmp(snapshot),
  };
}

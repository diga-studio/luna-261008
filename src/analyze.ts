import { createMatcher, PolicyMatcher } from './matcher';
import { Edge, findCycle } from './cycles';
import {
  AnalysisResult,
  CycleEvidence,
  MAX_PORT,
  MIN_PORT,
  Policy,
  PortCycle,
  PortProtocolResult,
  Protocol,
  SegmentId,
} from './types';

function validatePolicies(policies: readonly Policy[]): void {
  const seenPriorities = new Set<string>();
  for (const policy of policies) {
    if (policy.protocol !== 'TCP' && policy.protocol !== 'UDP' && policy.protocol !== 'ICMP') {
      throw new Error(`未知协议: ${String((policy as Policy).protocol)}`);
    }
    if (!Number.isInteger(policy.priority)) {
      throw new Error(`优先级必须为整数: ${policy.priority}`);
    }
    const key = `${policy.source}→${policy.destination}|${policy.protocol}|${policy.priority}`;
    if (seenPriorities.has(key)) {
      throw new Error(
        `同一有向网段对、同一协议的策略优先级重复: ${policy.source} -> ${policy.destination} ${policy.protocol} priority=${policy.priority}`,
      );
    }
    seenPriorities.add(key);
    if (policy.protocol !== 'ICMP') {
      const { start, end } = policy.portRange;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`端口范围必须为整数: [${start}, ${end}]`);
      }
      if (start < MIN_PORT || end > MAX_PORT || start > end) {
        throw new Error(`端口范围越界或倒置: [${start}, ${end}]`);
      }
    }
  }
}

interface DirectedPair {
  readonly source: SegmentId;
  readonly destination: SegmentId;
}

/** 收集指定协议下出现过策略的所有有向网段对（去重）。 */
function collectPairs(policies: readonly Policy[], protocol: Protocol): DirectedPair[] {
  const seen = new Set<string>();
  const pairs: DirectedPair[] = [];
  for (const policy of policies) {
    if (policy.protocol !== protocol) {
      continue;
    }
    const key = `${policy.source}→${policy.destination}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ source: policy.source, destination: policy.destination });
    }
  }
  return pairs;
}

/** 在指定协议与目的端口下，求出所有可通行的有向边。 */
function allowedEdges(
  matcher: PolicyMatcher,
  pairs: readonly DirectedPair[],
  protocol: Protocol,
  port: number,
): Edge[] {
  const edges: Edge[] = [];
  for (const pair of pairs) {
    const decision = matcher.decide(pair.source, pair.destination, protocol, port);
    if (decision.allowed && decision.winningAction !== null && decision.winningPriority !== null) {
      edges.push({
        source: pair.source,
        destination: pair.destination,
        action: decision.winningAction,
        priority: decision.winningPriority,
      });
    }
  }
  return edges;
}

/**
 * 把 [0, 65535] 按所有策略端口范围的边界切成若干区间。
 * 同一区间内每个端口的策略匹配结果完全一致。
 */
function portIntervals(policies: readonly Policy[], protocol: Protocol): Array<{ start: number; end: number }> {
  const boundaries = new Set<number>([MIN_PORT, MAX_PORT + 1]);
  for (const policy of policies) {
    if (policy.protocol === 'ICMP' || policy.protocol !== protocol) {
      continue;
    }
    boundaries.add(policy.portRange.start);
    if (policy.portRange.end < MAX_PORT) {
      boundaries.add(policy.portRange.end + 1);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const intervals: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]! - 1;
    if (start <= end) {
      intervals.push({ start, end });
    }
  }
  return intervals;
}

function analyzePortProtocol(
  policies: readonly Policy[],
  matcher: PolicyMatcher,
  protocol: 'TCP' | 'UDP',
): PortProtocolResult {
  const pairs = collectPairs(policies, protocol);
  const segments = matcher.segments();
  const ports: number[] = [];
  const evidence: PortCycle[] = [];

  for (const interval of portIntervals(policies, protocol)) {
    const edges = allowedEdges(matcher, pairs, protocol, interval.start);
    const cycle = findCycle(segments, edges);
    if (cycle === null) {
      continue;
    }
    for (let port = interval.start; port <= interval.end; port++) {
      ports.push(port);
      evidence.push({ port, evidence: cycle });
    }
  }
  return { ports, evidence };
}

function analyzeIcmp(policies: readonly Policy[], matcher: PolicyMatcher): { hasCycle: boolean; evidence: CycleEvidence | null } {
  const pairs = collectPairs(policies, 'ICMP');
  const edges = allowedEdges(matcher, pairs, 'ICMP', 0);
  const cycle = findCycle(matcher.segments(), edges);
  return { hasCycle: cycle !== null, evidence: cycle };
}

/**
 * 对完整的候选策略集做一次闭环分析。
 * 输入在分析期间不会被修改；结果只保存在内存中。
 * 输入非法（端口越界、优先级重复等）时抛出 Error。
 */
export function analyzePolicies(policies: readonly Policy[]): AnalysisResult {
  validatePolicies(policies);
  const snapshot = policies.map((policy) =>
    policy.protocol === 'ICMP' ? { ...policy } : { ...policy, portRange: { ...policy.portRange } },
  );
  const matcher = createMatcher(snapshot);
  return {
    tcp: analyzePortProtocol(snapshot, matcher, 'TCP'),
    udp: analyzePortProtocol(snapshot, matcher, 'UDP'),
    icmp: analyzeIcmp(snapshot, matcher),
  };
}

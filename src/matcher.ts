import { Action, Policy, Protocol, SegmentId } from './types';

/** 一跳的判定结果：是否可通行，以及胜出的策略（无匹配策略时为 null，即默认拒绝）。 */
export interface HopDecision {
  readonly allowed: boolean;
  readonly winningAction: Action | null;
  readonly winningPriority: number | null;
}

/**
 * 策略匹配器：对（源网段, 目标网段, 协议, 目的端口）给出唯一生效策略的判定。
 * 对 ICMP 调用时 port 参数被忽略。
 */
export interface PolicyMatcher {
  decide(source: SegmentId, destination: SegmentId, protocol: Protocol, port: number): HopDecision;
  /** 出现过的所有网段标识。 */
  segments(): readonly SegmentId[];
}

function edgeKey(source: SegmentId, destination: SegmentId, protocol: Protocol): string {
  return `${source}→${destination}|${protocol}`;
}

export function createMatcher(policies: readonly Policy[]): PolicyMatcher {
  const byEdge = new Map<string, Policy[]>();
  const segmentSet = new Set<SegmentId>();

  for (const policy of policies) {
    segmentSet.add(policy.source);
    segmentSet.add(policy.destination);
    const key = edgeKey(policy.source, policy.destination, policy.protocol);
    const list = byEdge.get(key);
    if (list) {
      list.push(policy);
    } else {
      byEdge.set(key, [policy]);
    }
  }
  // 每条有向边 + 协议内按优先级数值升序，命中即生效，不看更低优先级（数值更大）的规则。
  for (const list of byEdge.values()) {
    list.sort((a, b) => a.priority - b.priority);
  }

  const segmentList = [...segmentSet];

  return {
    decide(source, destination, protocol, port) {
      const list = byEdge.get(edgeKey(source, destination, protocol));
      if (!list) {
        return { allowed: false, winningAction: null, winningPriority: null };
      }
      for (const policy of list) {
        if (policy.protocol === 'ICMP' || (policy.portRange.start <= port && port <= policy.portRange.end)) {
          return {
            allowed: policy.action !== 'Deny',
            winningAction: policy.action,
            winningPriority: policy.priority,
          };
        }
      }
      return { allowed: false, winningAction: null, winningPriority: null };
    },
    segments() {
      return segmentList;
    },
  };
}

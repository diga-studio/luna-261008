import type { Policy, PortRange, SegmentId, TcpUdpPolicy } from "./types.js";

const MIN_PORT = 0;
const MAX_PORT = 65535;

function allows(action: TcpUdpPolicy["action"]): boolean {
  return action === "Allow" || action === "Log-and-Allow";
}

function matchingTcpUdp(
  policies: readonly Policy[],
  source: SegmentId,
  target: SegmentId,
  protocol: "TCP" | "UDP",
): TcpUdpPolicy[] {
  return policies.filter(
    (p): p is TcpUdpPolicy =>
      p.protocol === protocol && p.source === source && p.target === target,
  );
}

/**
 * 计算某有向网段对、某协议下，各目的端口的生效结果。
 * 返回允许通行的端口闭区间集合（不重叠、升序）。
 * 生效规则：匹配策略中优先级数值最小者生效；无匹配则拒绝；
 * Deny 胜出会截断低优先级 Allow 的通行范围。
 */
export function allowedPortRanges(
  policies: readonly Policy[],
  source: SegmentId,
  target: SegmentId,
  protocol: "TCP" | "UDP",
): PortRange[] {
  const sorted = matchingTcpUdp(policies, source, target, protocol)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  // covered 记录已被更高优先级（数值更小）策略裁決过的端口区间。
  const covered: PortRange[] = [];
  const allowed: PortRange[] = [];

  for (const policy of sorted) {
    let pending: PortRange[] = [
      { min: Math.max(policy.portRange.min, MIN_PORT), max: Math.min(policy.portRange.max, MAX_PORT) },
    ];
    if (pending[0]!.min > pending[0]!.max) continue;
    // 从本策略端口中扣除已被更高优先级策略覆盖的部分。
    for (const c of covered) {
      const next: PortRange[] = [];
      for (const r of pending) {
        if (c.max < r.min || c.min > r.max) {
          next.push(r);
        } else {
          if (r.min < c.min) next.push({ min: r.min, max: c.min - 1 });
          if (r.max > c.max) next.push({ min: c.max + 1, max: r.max });
        }
      }
      pending = next;
    }
    if (pending.length === 0) continue;
    covered.push(...pending);
    if (allows(policy.action)) allowed.push(...pending);
  }

  return mergeRanges(allowed);
}

function mergeRanges(ranges: PortRange[]): PortRange[] {
  const sorted = ranges.slice().sort((a, b) => a.min - b.min || a.max - b.max);
  const merged: PortRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.min <= last.max + 1) {
      if (r.max > last.max) (last as { max: number }).max = r.max;
    } else {
      merged.push({ min: r.min, max: r.max });
    }
  }
  return merged;
}

/** 判断某有向网段对、某协议、某目的端口是否允许通行。 */
export function isAllowed(
  policies: readonly Policy[],
  source: SegmentId,
  target: SegmentId,
  protocol: "TCP" | "UDP",
  port: number,
): boolean {
  let winner: TcpUdpPolicy | undefined;
  for (const p of matchingTcpUdp(policies, source, target, protocol)) {
    if (port < p.portRange.min || port > p.portRange.max) continue;
    if (!winner || p.priority < winner.priority) winner = p;
  }
  return winner !== undefined && allows(winner.action);
}

/** 判断某有向网段对的 ICMP 是否允许通行。 */
export function isIcmpAllowed(
  policies: readonly Policy[],
  source: SegmentId,
  target: SegmentId,
): boolean {
  let winner: Policy | undefined;
  for (const p of policies) {
    if (p.protocol !== "ICMP" || p.source !== source || p.target !== target) continue;
    if (!winner || p.priority < winner.priority) winner = p;
  }
  return winner !== undefined && allows(winner.action);
}

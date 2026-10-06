import type {
  AuthProfile,
  Condition,
  Connection,
  Decision,
  Device,
  PolicyConfig,
  Rule,
  Segment,
  TimeWindow,
} from './types';

export function windowContains(window: TimeWindow, minute: number): boolean {
  if (window.start === window.end) return true; // all day
  if (window.start < window.end) return minute >= window.start && minute < window.end;
  return minute >= window.start || minute < window.end; // wraps past midnight
}

function conditionMatches<V>(condition: Condition<V>, value: V): boolean {
  return condition === '*' || condition === value;
}

export function ruleMatches(
  rule: Rule,
  profile: AuthProfile,
  connection: Connection,
  minute: number,
): boolean {
  return (
    conditionMatches(rule.role, profile.role) &&
    conditionMatches(rule.method, profile.method) &&
    conditionMatches(rule.trust, profile.trust) &&
    conditionMatches(rule.connection, connection) &&
    windowContains(rule.window, minute)
  );
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority);
}

function toDecision(segment: Segment): Decision {
  return {
    vlan: segment.vlan,
    allowedCIDRs: segment.allowedCIDRs,
    bandwidth: segment.bandwidth,
  };
}

/** Effective permission of a segment for a device: the segment itself if its
 *  VLAN is supported, otherwise the device's isolation segment. */
export function effectiveDecision(
  segment: Segment,
  device: Device,
  segmentsById: Map<string, Segment>,
): Decision {
  if (device.supportedVlans.includes(segment.vlan)) return toDecision(segment);
  const isolation = segmentsById.get(device.isolationSegmentId);
  if (!isolation) throw new Error(`unknown isolation segment: ${device.isolationSegmentId}`);
  return toDecision(isolation);
}

export function decide(
  config: PolicyConfig,
  profileId: string,
  deviceId: string,
  connection: Connection,
  minute: number,
): Decision {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`unknown profile: ${profileId}`);
  const device = config.devices.find((d) => d.id === deviceId);
  if (!device) throw new Error(`unknown device: ${deviceId}`);
  const segmentsById = new Map(config.segments.map((s) => [s.id, s]));

  for (const rule of sortRules(config.rules)) {
    if (!ruleMatches(rule, profile, connection, minute)) continue;
    const target = segmentsById.get(rule.segmentId);
    if (!target) throw new Error(`unknown segment: ${rule.segmentId}`);
    // First matching rule decides; unsupported target VLAN falls back to
    // isolation immediately without trying later rules.
    return effectiveDecision(target, device, segmentsById);
  }
  const isolation = segmentsById.get(device.isolationSegmentId);
  if (!isolation) throw new Error(`unknown isolation segment: ${device.isolationSegmentId}`);
  return toDecision(isolation);
}

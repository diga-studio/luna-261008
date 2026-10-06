export type Connection = 'wired' | 'wireless';

/** A wildcard-or-single-value condition. */
export type Condition<V> = V | '*';

export interface AuthProfile {
  id: string;
  role: string;
  method: string;
  trust: string;
}

export interface Segment {
  id: string;
  vlan: number; // 1..4094, globally unique
  allowedCIDRs: string[]; // already normalized
  bandwidth: number;
}

export interface Device {
  id: string;
  supportedVlans: number[];
  isolationSegmentId: string;
}

/** Minutes-of-day window, [start, end). start === end means all day. May wrap past midnight. */
export interface TimeWindow {
  start: number; // 0..1439
  end: number; // 0..1439
}

export interface Rule {
  id: string;
  priority: number; // unique, smaller wins
  segmentId: string;
  role: Condition<string>;
  method: Condition<string>;
  trust: Condition<string>;
  connection: Condition<Connection>;
  window: TimeWindow;
}

export interface PolicyConfig {
  profiles: AuthProfile[];
  segments: Segment[];
  devices: Device[];
  rules: Rule[];
}

export interface Decision {
  vlan: number;
  allowedCIDRs: string[];
  bandwidth: number;
}

export interface AuditWitness {
  profileId: string;
  deviceId: string;
  connection: Connection;
  minute: number;
  before: Decision;
  after: Decision;
}

export interface RuleAudit {
  ruleId: string;
  safeToRemove: boolean;
  witness?: AuditWitness;
}

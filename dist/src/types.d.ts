export declare type Connection = "wired" | "wireless";
export interface AuthProfile {
    id: string;
    role: string;
    method: string;
    trust: string;
}
export interface Segment {
    id: string;
    vlan: number;
    allowedCIDRs: string[];
    bandwidth: number;
}
export interface Device {
    id: string;
    supportedVlans: number[];
    quarantineSegmentId: string;
}
export declare type ConditionValue = string | "*";
export interface TimeWindow {
    start: number;
    end: number;
}
export interface Rule {
    id: string;
    priority: number;
    segmentId: string;
    role: ConditionValue;
    method: ConditionValue;
    trust: ConditionValue;
    connection: ConditionValue;
    window: TimeWindow;
}
export interface PolicyConfig {
    profiles: AuthProfile[];
    segments: Segment[];
    devices: Device[];
    rules: Rule[];
}
export interface Permission {
    vlan: number;
    allowedCIDRs: string[];
    bandwidth: number;
}
export interface Counterexample {
    profileId: string;
    deviceId: string;
    connection: Connection;
    minute: number;
    before: Permission;
    after: Permission;
}
export interface RuleAuditResult {
    ruleId: string;
    safeToRemove: boolean;
    counterexample?: Counterexample;
}

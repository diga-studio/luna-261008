export type Direction = "in" | "out";

export type Protocol = "tcp" | "udp" | "icmp" | "any";

export type ConcreteProtocol = "tcp" | "udp" | "icmp";

export type Action = "allow" | "deny" | "log";

export interface PortRange {
  start: number;
  end: number;
}

export interface FirewallRule {
  id: string;
  priority: number;
  direction: Direction;
  protocol: Protocol;
  sourceCidr: string;
  destinationCidr: string;
  action: Action;
  portRange?: PortRange;
}

export interface Connection {
  direction: Direction;
  protocol: ConcreteProtocol;
  sourceAddress: string;
  destinationAddress: string;
  destinationPort?: number;
}

export type RuleStatus = "reachable" | "shadowed";

export interface RuleVerdict {
  ruleId: string;
  status: RuleStatus;
  witness?: Connection;
}

export interface AuditReport {
  verdicts: RuleVerdict[];
}

export interface EvalResult {
  ruleId: string | null;
  action: Action;
}

/** 入站或出站方向。 */
export type Direction = 'inbound' | 'outbound';
/** 规则协议。ANY 覆盖 TCP/UDP/ICMP，且不设置端口条件。 */
export type RuleProtocol = 'TCP' | 'UDP' | 'ICMP' | 'ANY';
/** 连接的具体协议（不含 ANY）。 */
export type ConcreteProtocol = 'TCP' | 'UDP' | 'ICMP';
export type Action = 'allow' | 'deny' | 'log';
/** 目的端口闭区间，0-65535。仅 TCP/UDP 规则携带。 */
export interface PortRange {
    readonly start: number;
    readonly end: number;
}
export interface Rule {
    readonly id: string;
    /** 1-1000，数字越小越先检查；相同优先级按输入顺序。 */
    readonly priority: number;
    readonly direction: Direction;
    readonly protocol: RuleProtocol;
    readonly sourceCidr: string;
    readonly destCidr: string;
    readonly action: Action;
    /** TCP/UDP 规则必填；ICMP/ANY 规则不得携带。 */
    readonly portRange?: PortRange;
}
export interface Connection {
    readonly direction: Direction;
    readonly protocol: ConcreteProtocol;
    readonly sourceAddress: string;
    readonly destAddress: string;
    /** TCP/UDP 连接必填；ICMP 连接不得携带。 */
    readonly destPort?: number;
}
export type RuleStatus = 'reachable' | 'shadowed';
export interface RuleAudit {
    readonly ruleId: string;
    readonly status: RuleStatus;
    /** 可达规则附带的见证连接：以该规则为首个命中者。 */
    readonly witness?: Connection;
}
export interface MatchResult {
    /** 首个命中的规则；无命中时为 null（默认 deny）。 */
    readonly ruleId: string | null;
    readonly action: Action | 'default-deny';
}

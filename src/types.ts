/** 网段标识由调用方提供，库内只做相等性比较，不解析 CIDR 或拓扑。 */
export type SegmentId = string;

export type Protocol = 'TCP' | 'UDP' | 'ICMP';

export type Action = 'Allow' | 'Deny' | 'Log-and-Allow';

export const MIN_PORT = 0;
export const MAX_PORT = 65535;

/** 闭区间目的端口范围。 */
export interface PortRange {
  readonly start: number;
  readonly end: number;
}

interface PolicyBase {
  readonly source: SegmentId;
  readonly destination: SegmentId;
  readonly action: Action;
  /** 整数优先级，数值小者生效；同一有向网段对 + 同一协议内不得重复。 */
  readonly priority: number;
}

/** TCP / UDP 策略，带闭区间目的端口条件。 */
export interface PortPolicy extends PolicyBase {
  readonly protocol: 'TCP' | 'UDP';
  readonly portRange: PortRange;
}

/** ICMP 策略，无端口条件。 */
export interface IcmpPolicy extends PolicyBase {
  readonly protocol: 'ICMP';
}

export type Policy = PortPolicy | IcmpPolicy;

/** 证据中的一跳：胜出策略为 Allow 或 Log-and-Allow。 */
export interface Hop {
  readonly source: SegmentId;
  readonly destination: SegmentId;
  readonly action: Action;
  readonly priority: number;
}

/**
 * 一条可逐跳核验的闭环证据。
 * segments 首尾相同，长度 >= 3，除首尾外不重复；hops 与相邻网段一一对应。
 */
export interface CycleEvidence {
  readonly segments: readonly SegmentId[];
  readonly hops: readonly Hop[];
}

/** 某个目的端口上存在闭环，附一条证据。 */
export interface PortCycle {
  readonly port: number;
  readonly evidence: CycleEvidence;
}

export interface PortProtocolResult {
  /** 所有存在闭环的目的端口，升序、去重。 */
  readonly ports: readonly number[];
  /** 每个闭环端口对应一条证据，与 ports 一一对应。 */
  readonly evidence: readonly PortCycle[];
}

export interface IcmpResult {
  readonly hasCycle: boolean;
  /** 存在闭环时附一条可逐跳核验的证据。 */
  readonly evidence: CycleEvidence | null;
}

export interface AnalysisResult {
  readonly tcp: PortProtocolResult;
  readonly udp: PortProtocolResult;
  readonly icmp: IcmpResult;
}

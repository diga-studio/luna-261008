/** 网段标识，由调用方提供。 */
export type SegmentId = string;

export type Protocol = "TCP" | "UDP" | "ICMP";

export type Action = "Allow" | "Deny" | "Log-and-Allow";

/** 闭区间目的端口范围，0-65535。 */
export interface PortRange {
  readonly min: number;
  readonly max: number;
}

interface PolicyBase {
  readonly source: SegmentId;
  readonly target: SegmentId;
  readonly action: Action;
  /** 同一有向网段对、同一协议内不重复的整数优先级，数值小者胜出。 */
  readonly priority: number;
}

export interface TcpUdpPolicy extends PolicyBase {
  readonly protocol: "TCP" | "UDP";
  readonly portRange: PortRange;
}

export interface IcmpPolicy extends PolicyBase {
  readonly protocol: "ICMP";
}

export type Policy = TcpUdpPolicy | IcmpPolicy;

/** 闭环中的一跳：从 source 网段到 target 网段。 */
export interface Hop {
  readonly source: SegmentId;
  readonly target: SegmentId;
}

/**
 * 一条可逐跳核验的闭环证据：
 * 所有跳使用同一协议（TCP/UDP 还包括同一目的端口），
 * 依次衔接并返回起点，除首尾外网段不重复。
 */
export interface CycleEvidence {
  readonly protocol: Protocol;
  /** 仅 TCP/UDP 存在。 */
  readonly port?: number;
  readonly hops: readonly Hop[];
}

export interface PortProtocolResult {
  /** 所有存在闭环的目的端口，升序。 */
  readonly ports: readonly number[];
  /** 每个端口对应的一条可核验闭环证据。 */
  readonly evidence: ReadonlyMap<number, CycleEvidence>;
}

export interface IcmpResult {
  readonly hasCycle: boolean;
  /** 存在闭环时附一条可核验证据。 */
  readonly evidence?: CycleEvidence;
}

export interface AnalysisResult {
  readonly tcp: PortProtocolResult;
  readonly udp: PortProtocolResult;
  readonly icmp: IcmpResult;
}

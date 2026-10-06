/** OS 版本：主版本与次版本，均为非负整数，按数值逐段比较。 */
export interface OsVersion {
  major: number;
  minor: number;
}

/** 全体设备共用的合规规则。 */
export interface ComplianceRules {
  minOsVersion: OsVersion;
  requirePassword: boolean;
  requireEncryption: boolean;
}

/** 设备上报的状态报告。 */
export interface DeviceReport {
  osVersion: OsVersion;
  passwordSet: boolean;
  encryptionOn: boolean;
  /** 设备侧单调递增的报告序号。 */
  sequence: number;
}

/** 设备评估状态。 */
export type EvaluationStatus = "pending" | "compliant" | "non-compliant";

/** 调用方可观察的设备状态。 */
export interface DeviceState {
  status: EvaluationStatus;
  /** 未通过有效合规评估即处于隔离。 */
  isolated: boolean;
  hasReport: boolean;
  /** 当前生效报告对应的规则版本；无报告时为 null。 */
  reportSequence: number | null;
}

/** 安装请求，负载类型由调用方决定。 */
export interface InstallRequest<T = unknown> {
  id: string;
  payload: T;
}

/**
 * 评估器：模块内异步工作的抽象。
 * 给定规则快照与报告快照，异步得出是否合规。
 */
export type Evaluator = (
  rules: ComplianceRules,
  report: DeviceReport
) => Promise<boolean>;

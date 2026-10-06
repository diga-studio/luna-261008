/** iOS OS 版本，由主版本与次版本两个非负整数组成。 */
export interface OsVersion {
  major: number;
  minor: number;
}

/** 全体设备共用的合规规则。 */
export interface ComplianceRule {
  minOsVersion: OsVersion;
  requirePassword: boolean;
  requireEncryption: boolean;
}

/** 设备上报的合规相关状态。 */
export interface DeviceReport {
  /** 设备单调递增的报告序号。 */
  sequence: number;
  osVersion: OsVersion;
  passwordSet: boolean;
  encryptionEnabled: boolean;
}

/** 调用方可观察的设备状态。 */
export enum DeviceStatus {
  /** 待评估：规则或报告刚生效，异步评估尚未产出有效结论。设备保持隔离。 */
  PendingEvaluation = "pending_evaluation",
  /** 合规：当前规则版本 + 当前报告的有效评估结论为合规。 */
  Compliant = "compliant",
  /** 不合规：当前规则版本 + 当前报告的有效评估结论为不合规。设备保持隔离。 */
  NonCompliant = "non_compliant",
  /** 隔离：没有任何报告，或尚无任何有效评估结论。 */
  Isolated = "isolated",
}

/** 一次安装请求登记后得到的凭据。 */
export interface InstallRequest {
  readonly id: number;
  readonly deviceId: string;
  readonly payload: unknown;
}

/** 领取到的一条安装指令。 */
export interface InstallInstruction {
  readonly requestId: number;
  readonly deviceId: string;
  readonly payload: unknown;
}

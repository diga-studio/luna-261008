import {
  ComplianceRule,
  DeviceReport,
  DeviceStatus,
  InstallInstruction,
  InstallRequest,
  OsVersion,
} from "./types.js";

/** 评估器：对（规则, 设备报告）异步产出是否合规的结论。 */
export type Evaluator = (
  rule: ComplianceRule,
  report: DeviceReport,
) => Promise<boolean>;

export interface FleetGuardOptions {
  /** 可注入的评估器，便于测试控制异步评估的完成时机。 */
  evaluator?: Evaluator;
}

interface SettledConclusion {
  ruleVersion: number;
  reportSequence: number;
  compliant: boolean;
}

interface DeviceState {
  currentReport: DeviceReport | null;
  /** 等待一次能反映当前规则版本与当前报告的评估结论。 */
  pending: boolean;
  /** 最近一次生效（非迟到）的评估结论。 */
  settled: SettledConclusion | null;
  installQueue: InstallRequest[];
}

function compareOsVersion(a: OsVersion, b: OsVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

function defaultEvaluator(
  rule: ComplianceRule,
  report: DeviceReport,
): Promise<boolean> {
  const compliant =
    compareOsVersion(report.osVersion, rule.minOsVersion) >= 0 &&
    (!rule.requirePassword || report.passwordSet) &&
    (!rule.requireEncryption || report.encryptionEnabled);
  return Promise.resolve(compliant);
}

export class FleetGuard {
  private readonly evaluator: Evaluator;
  private rule: ComplianceRule | null = null;
  private ruleVersion = 0;
  private readonly devices = new Map<string, DeviceState>();
  private nextRequestId = 1;

  constructor(options?: FleetGuardOptions) {
    this.evaluator = options?.evaluator ?? defaultEvaluator;
  }

  /** 编辑规则：产生新的规则版本，全体设备立即进入待评估并保持隔离。 */
  editRules(rule: ComplianceRule): number {
    this.rule = rule;
    this.ruleVersion += 1;
    for (const [deviceId, device] of this.devices) {
      if (device.currentReport !== null) {
        device.pending = true;
        this.scheduleEvaluation(deviceId, device.currentReport);
      }
    }
    return this.ruleVersion;
  }

  /** 接收设备报告：仅更大序号生效；生效后该设备立即进入待评估并保持隔离。 */
  receiveReport(deviceId: string, report: DeviceReport): boolean {
    const device = this.getOrCreateDevice(deviceId);
    if (
      device.currentReport !== null &&
      report.sequence <= device.currentReport.sequence
    ) {
      return false;
    }
    device.currentReport = report;
    if (this.rule !== null) {
      device.pending = true;
      this.scheduleEvaluation(deviceId, report);
    }
    return true;
  }

  /** 登记安装请求：隔离期间也可登记并保留。 */
  registerInstallRequest(deviceId: string, payload: unknown): InstallRequest {
    const device = this.getOrCreateDevice(deviceId);
    const request: InstallRequest = {
      id: this.nextRequestId++,
      deviceId,
      payload,
    };
    device.installQueue.push(request);
    return request;
  }

  /** 领取安装指令：仅当设备当前有效评估为合规时，至多返回一条。 */
  claimInstallInstruction(deviceId: string): InstallInstruction | null {
    if (this.getDeviceStatus(deviceId) !== DeviceStatus.Compliant) {
      return null;
    }
    const device = this.devices.get(deviceId)!;
    const request = device.installQueue.shift();
    if (request === undefined) {
      return null;
    }
    return {
      requestId: request.id,
      deviceId: request.deviceId,
      payload: request.payload,
    };
  }

  /** 观察设备当前状态。 */
  getDeviceStatus(deviceId: string): DeviceStatus {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.currentReport === null) {
      return DeviceStatus.Isolated;
    }
    if (device.pending) {
      return DeviceStatus.PendingEvaluation;
    }
    if (
      device.settled !== null &&
      device.settled.ruleVersion === this.ruleVersion &&
      device.settled.reportSequence === device.currentReport.sequence
    ) {
      return device.settled.compliant
        ? DeviceStatus.Compliant
        : DeviceStatus.NonCompliant;
    }
    return DeviceStatus.Isolated;
  }

  private getOrCreateDevice(deviceId: string): DeviceState {
    let device = this.devices.get(deviceId);
    if (device === undefined) {
      device = {
        currentReport: null,
        pending: false,
        settled: null,
        installQueue: [],
      };
      this.devices.set(deviceId, device);
    }
    return device;
  }

  private scheduleEvaluation(deviceId: string, report: DeviceReport): void {
    const rule = this.rule!;
    const ruleVersion = this.ruleVersion;
    const reportSequence = report.sequence;
    void this.evaluator(rule, report).then((compliant) => {
      this.settleEvaluation(deviceId, ruleVersion, reportSequence, compliant);
    });
  }

  private settleEvaluation(
    deviceId: string,
    ruleVersion: number,
    reportSequence: number,
    compliant: boolean,
  ): void {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.currentReport === null) {
      return;
    }
    // 迟到的结论：规则版本或报告序号已向前推进，不能改变状态。
    if (ruleVersion !== this.ruleVersion) {
      return;
    }
    if (reportSequence !== device.currentReport.sequence) {
      return;
    }
    device.settled = { ruleVersion, reportSequence, compliant };
    device.pending = false;
  }
}

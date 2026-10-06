import type {
  ComplianceRules,
  DeviceReport,
  DeviceState,
  Evaluator,
  InstallRequest,
  OsVersion,
} from "./types.js";

export interface ComplianceModuleOptions {
  /** 初始规则，作为第 1 个规则版本。 */
  initialRules: ComplianceRules;
  /** 可选自定义评估器；默认按规则同步判定后包装为异步。 */
  evaluator?: Evaluator;
}

interface DeviceRecord {
  report: DeviceReport | null;
  status: "pending" | "compliant" | "non-compliant";
  queue: InstallRequest<unknown>[];
}

function assertOsVersion(v: OsVersion, field: string): void {
  for (const part of [v.major, v.minor]) {
    if (!Number.isInteger(part) || part < 0) {
      throw new Error(`${field}: OS 版本段必须为非负整数`);
    }
  }
}

function compareOsVersion(a: OsVersion, b: OsVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

function copyRules(rules: ComplianceRules): ComplianceRules {
  return { ...rules, minOsVersion: { ...rules.minOsVersion } };
}

function copyReport(report: DeviceReport): DeviceReport {
  return { ...report, osVersion: { ...report.osVersion } };
}

function defaultEvaluator(
  rules: ComplianceRules,
  report: DeviceReport
): Promise<boolean> {
  const ok =
    compareOsVersion(report.osVersion, rules.minOsVersion) >= 0 &&
    (!rules.requirePassword || report.passwordSet) &&
    (!rules.requireEncryption || report.encryptionOn);
  return Promise.resolve(ok);
}

/**
 * FleetGuard 合规隔离模块（仅 iOS，全体设备共用一套规则）。
 * 由上层作为库调用。
 */
export class ComplianceModule {
  private rules: ComplianceRules;
  private ruleVersion: number;
  private readonly evaluator: Evaluator;
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: ComplianceModuleOptions) {
    assertOsVersion(options.initialRules.minOsVersion, "initialRules");
    this.rules = copyRules(options.initialRules);
    this.ruleVersion = 1;
    this.evaluator = options.evaluator ?? defaultEvaluator;
  }

  /** 编辑规则，产生新的规则版本并返回版本号。 */
  editRules(rules: ComplianceRules): number {
    assertOsVersion(rules.minOsVersion, "rules");
    this.rules = copyRules(rules);
    this.ruleVersion += 1;
    // 规则生效：全体设备立即进入待评估并保持隔离，旧结论一律作废。
    for (const record of this.devices.values()) {
      record.status = "pending";
    }
    for (const [deviceId, record] of this.devices) {
      if (record.report !== null) {
        this.scheduleEvaluation(deviceId);
      }
    }
    return this.ruleVersion;
  }

  /** 接收设备报告；仅更大序号被接受，返回是否生效。 */
  receiveReport(deviceId: string, report: DeviceReport): boolean {
    assertOsVersion(report.osVersion, "report");
    const record = this.recordOf(deviceId);
    if (record.report !== null && report.sequence <= record.report.sequence) {
      return false; // 重复或较旧报告不改变任何状态
    }
    record.report = copyReport(report);
    record.status = "pending"; // 新报告生效：该设备立即进入待评估并保持隔离
    this.scheduleEvaluation(deviceId);
    return true;
  }

  /** 登记安装请求；隔离期间也可登记并保留。 */
  registerInstallRequest<T>(deviceId: string, request: InstallRequest<T>): void {
    this.recordOf(deviceId).queue.push(request as InstallRequest<unknown>);
  }

  /** 领取安装指令；至多返回一条，未合规时返回 null。 */
  claimInstall<T = unknown>(deviceId: string): InstallRequest<T> | null {
    const record = this.recordOf(deviceId);
    if (record.status !== "compliant" || record.queue.length === 0) {
      return null;
    }
    return record.queue.shift() as InstallRequest<T>;
  }

  /** 观察设备状态。 */
  getDeviceState(deviceId: string): DeviceState {
    const record = this.recordOf(deviceId);
    return {
      status: record.status,
      isolated: record.status !== "compliant",
      hasReport: record.report !== null,
      reportSequence: record.report === null ? null : record.report.sequence,
    };
  }

  /** 等待当前已排期的异步评估全部落定（供测试与调用方同步观察）。 */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  private recordOf(deviceId: string): DeviceRecord {
    let record = this.devices.get(deviceId);
    if (record === undefined) {
      record = { report: null, status: "pending", queue: [] };
      this.devices.set(deviceId, record);
    }
    return record;
  }

  /**
   * 排期一次异步评估。快照当前规则版本与设备当前报告；
   * 结论落定时不匹配当前规则版本或当前报告的，直接丢弃。
   */
  private scheduleEvaluation(deviceId: string): void {
    const record = this.recordOf(deviceId);
    const report = record.report;
    if (report === null) return;
    const ruleVersion = this.ruleVersion;
    const rules = this.rules;
    const task = (async () => {
      let compliant: boolean;
      try {
        compliant = await this.evaluator(rules, report);
      } catch {
        return; // 评估失败不改变状态，设备保持待评估与隔离
      }
      if (this.ruleVersion !== ruleVersion) return; // 迟到的结论：规则已变
      if (record.report !== report) return; // 迟到的结论：报告已更新
      record.status = compliant ? "compliant" : "non-compliant";
    })();
    this.inflight.add(task);
    task.finally(() => this.inflight.delete(task));
  }
}

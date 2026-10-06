import { ComplianceRule, DeviceReport, DeviceStatus, InstallInstruction, InstallRequest } from "./types.js";
/** 评估器：对（规则, 设备报告）异步产出是否合规的结论。 */
export type Evaluator = (rule: ComplianceRule, report: DeviceReport) => Promise<boolean>;
export interface FleetGuardOptions {
    /** 可注入的评估器，便于测试控制异步评估的完成时机。 */
    evaluator?: Evaluator;
}
export declare class FleetGuard {
    private readonly evaluator;
    private rule;
    private ruleVersion;
    private readonly devices;
    private nextRequestId;
    constructor(options?: FleetGuardOptions);
    /** 编辑规则：产生新的规则版本，全体设备立即进入待评估并保持隔离。 */
    editRules(rule: ComplianceRule): number;
    /** 接收设备报告：仅更大序号生效；生效后该设备立即进入待评估并保持隔离。 */
    receiveReport(deviceId: string, report: DeviceReport): boolean;
    /** 登记安装请求：隔离期间也可登记并保留。 */
    registerInstallRequest(deviceId: string, payload: unknown): InstallRequest;
    /** 领取安装指令：仅当设备当前有效评估为合规时，至多返回一条。 */
    claimInstallInstruction(deviceId: string): InstallInstruction | null;
    /** 观察设备当前状态。 */
    getDeviceStatus(deviceId: string): DeviceStatus;
    private getOrCreateDevice;
    private scheduleEvaluation;
    private settleEvaluation;
}

import { DeviceStatus, } from "./types.js";
function compareOsVersion(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    return a.minor - b.minor;
}
function defaultEvaluator(rule, report) {
    const compliant = compareOsVersion(report.osVersion, rule.minOsVersion) >= 0 &&
        (!rule.requirePassword || report.passwordSet) &&
        (!rule.requireEncryption || report.encryptionEnabled);
    return Promise.resolve(compliant);
}
export class FleetGuard {
    evaluator;
    rule = null;
    ruleVersion = 0;
    devices = new Map();
    nextRequestId = 1;
    constructor(options) {
        this.evaluator = options?.evaluator ?? defaultEvaluator;
    }
    /** 编辑规则：产生新的规则版本，全体设备立即进入待评估并保持隔离。 */
    editRules(rule) {
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
    receiveReport(deviceId, report) {
        const device = this.getOrCreateDevice(deviceId);
        if (device.currentReport !== null &&
            report.sequence <= device.currentReport.sequence) {
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
    registerInstallRequest(deviceId, payload) {
        const device = this.getOrCreateDevice(deviceId);
        const request = {
            id: this.nextRequestId++,
            deviceId,
            payload,
        };
        device.installQueue.push(request);
        return request;
    }
    /** 领取安装指令：仅当设备当前有效评估为合规时，至多返回一条。 */
    claimInstallInstruction(deviceId) {
        if (this.getDeviceStatus(deviceId) !== DeviceStatus.Compliant) {
            return null;
        }
        const device = this.devices.get(deviceId);
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
    getDeviceStatus(deviceId) {
        const device = this.devices.get(deviceId);
        if (device === undefined || device.currentReport === null) {
            return DeviceStatus.Isolated;
        }
        if (device.pending) {
            return DeviceStatus.PendingEvaluation;
        }
        if (device.settled !== null &&
            device.settled.ruleVersion === this.ruleVersion &&
            device.settled.reportSequence === device.currentReport.sequence) {
            return device.settled.compliant
                ? DeviceStatus.Compliant
                : DeviceStatus.NonCompliant;
        }
        return DeviceStatus.Isolated;
    }
    getOrCreateDevice(deviceId) {
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
    scheduleEvaluation(deviceId, report) {
        const rule = this.rule;
        const ruleVersion = this.ruleVersion;
        const reportSequence = report.sequence;
        void this.evaluator(rule, report).then((compliant) => {
            this.settleEvaluation(deviceId, ruleVersion, reportSequence, compliant);
        });
    }
    settleEvaluation(deviceId, ruleVersion, reportSequence, compliant) {
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

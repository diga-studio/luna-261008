import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComplianceRule,
  DeviceReport,
  DeviceStatus,
  FleetGuard,
} from "../src/index.js";

interface PendingEval {
  rule: ComplianceRule;
  report: DeviceReport;
  resolve: (compliant: boolean) => void;
}

/** 可手动控制完成时机的评估器，每次评估调用按顺序记录。 */
class ControlledEvaluator {
  readonly calls: PendingEval[] = [];
  readonly evaluator = (
    rule: ComplianceRule,
    report: DeviceReport,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      this.calls.push({ rule, report, resolve });
    });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rule = (major: number, minor: number): ComplianceRule => ({
  minOsVersion: { major, minor },
  requirePassword: true,
  requireEncryption: true,
});

const report = (
  sequence: number,
  major: number,
  minor: number,
  passwordSet = true,
  encryptionEnabled = true,
): DeviceReport => ({
  sequence,
  osVersion: { major, minor },
  passwordSet,
  encryptionEnabled,
});

test("没有报告的设备始终隔离，不能领取安装指令", () => {
  const fg = new FleetGuard();
  fg.editRules(rule(16, 0));
  fg.registerInstallRequest("dev-1", { app: "mail" });
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Isolated);
  assert.equal(fg.claimInstallInstruction("dev-1"), null);
});

test("收紧规则后旧合规评估才结束，设备仍不能领取安装", async () => {
  const stub = new ControlledEvaluator();
  const fg = new FleetGuard({ evaluator: stub.evaluator });

  fg.editRules(rule(15, 0)); // 规则版本 1
  fg.receiveReport("dev-1", report(1, 16, 0));
  assert.equal(stub.calls.length, 1); // 旧规则下的评估已开始，尚未结束

  // 评估进行中收紧规则：版本 2，全体设备立即待评估并隔离
  fg.editRules(rule(17, 0));
  assert.equal(stub.calls.length, 2);
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.PendingEvaluation);

  fg.registerInstallRequest("dev-1", { app: "mail" });

  // 旧合规评估此刻才结束：结论已过期，不能解除隔离
  stub.calls[0].resolve(true);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.PendingEvaluation);
  assert.equal(fg.claimInstallInstruction("dev-1"), null);

  // 新规则下的评估结束：不合规，请求继续保留
  stub.calls[1].resolve(false);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.NonCompliant);
  assert.equal(fg.claimInstallInstruction("dev-1"), null);
});

test("新报告通过评估后旧不合规评估才结束，设备不能被重新隔离", async () => {
  const stub = new ControlledEvaluator();
  const fg = new FleetGuard({ evaluator: stub.evaluator });

  fg.editRules(rule(17, 0));
  fg.receiveReport("dev-1", report(1, 16, 0)); // 旧报告的评估 #1，尚未结束
  fg.receiveReport("dev-1", report(2, 17, 0)); // 新报告生效，触发评估 #2
  assert.equal(stub.calls.length, 2);

  fg.registerInstallRequest("dev-1", { app: "mail" });

  // 新报告的评估先结束：合规，原有请求自动具备领取资格
  stub.calls[1].resolve(true);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);
  const instruction = fg.claimInstallInstruction("dev-1");
  assert.ok(instruction !== null);
  assert.equal(instruction.deviceId, "dev-1");

  // 旧不合规评估此刻才结束：结论已过期，不能重新隔离
  stub.calls[0].resolve(false);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);

  fg.registerInstallRequest("dev-1", { app: "browser" });
  const second = fg.claimInstallInstruction("dev-1");
  assert.ok(second !== null);
  assert.deepEqual(second.payload, { app: "browser" });
});

test("重复或较旧序号的报告不改变任何状态", async () => {
  const stub = new ControlledEvaluator();
  const fg = new FleetGuard({ evaluator: stub.evaluator });

  fg.editRules(rule(15, 0));
  assert.equal(fg.receiveReport("dev-1", report(5, 16, 0)), true);
  assert.equal(fg.receiveReport("dev-1", report(5, 16, 0)), false); // 重复
  assert.equal(fg.receiveReport("dev-1", report(3, 16, 0)), false); // 较旧
  assert.equal(stub.calls.length, 1); // 只触发了一次评估

  stub.calls[0].resolve(true);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);
});

test("OS 版本按主、次版本数值逐段比较", async () => {
  const fg = new FleetGuard();
  fg.editRules({
    minOsVersion: { major: 10, minor: 0 },
    requirePassword: false,
    requireEncryption: false,
  });
  // 9.9 数值上低于 10.0，不能按字符串或单段判断
  fg.receiveReport("dev-low", report(1, 9, 9));
  fg.receiveReport("dev-ok", report(1, 10, 0));
  await tick();
  assert.equal(fg.getDeviceStatus("dev-low"), DeviceStatus.NonCompliant);
  assert.equal(fg.getDeviceStatus("dev-ok"), DeviceStatus.Compliant);
});

test("每次领取至多一条，每条请求最多被领取一次", async () => {
  const fg = new FleetGuard();
  fg.editRules(rule(15, 0));
  fg.receiveReport("dev-1", report(1, 16, 0));
  fg.registerInstallRequest("dev-1", "a");
  fg.registerInstallRequest("dev-1", "b");
  await tick();

  const first = fg.claimInstallInstruction("dev-1");
  const second = fg.claimInstallInstruction("dev-1");
  assert.equal(first?.payload, "a");
  assert.equal(second?.payload, "b");
  assert.equal(fg.claimInstallInstruction("dev-1"), null); // 队列已空
});

test("不合规期间登记的请求在后续合规评估后自动具备领取资格", async () => {
  const fg = new FleetGuard();
  fg.editRules(rule(17, 0));
  fg.receiveReport("dev-1", report(1, 16, 0));
  fg.registerInstallRequest("dev-1", { app: "mail" });
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.NonCompliant);
  assert.equal(fg.claimInstallInstruction("dev-1"), null);

  fg.receiveReport("dev-1", report(2, 17, 0));
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);
  const instruction = fg.claimInstallInstruction("dev-1");
  assert.ok(instruction !== null);
  assert.deepEqual(instruction.payload, { app: "mail" });
});

test("恢复旧规则内容也属于新版本，先前结论不能继续提供安装资格", async () => {
  const fg = new FleetGuard();
  fg.editRules(rule(15, 0)); // v1
  fg.receiveReport("dev-1", report(1, 16, 0));
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);

  fg.editRules(rule(17, 0)); // v2 收紧
  fg.editRules(rule(15, 0)); // v3 恢复旧内容，仍是新版本
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.PendingEvaluation);
  assert.equal(fg.claimInstallInstruction("dev-1"), null);
  await tick();
  assert.equal(fg.getDeviceStatus("dev-1"), DeviceStatus.Compliant);
});

import test from "node:test";
import assert from "node:assert/strict";
import { ComplianceModule } from "../src/index.js";
import type {
  ComplianceRules,
  DeviceReport,
  Evaluator,
} from "../src/index.js";

const relaxedRules: ComplianceRules = {
  minOsVersion: { major: 14, minor: 0 },
  requirePassword: false,
  requireEncryption: false,
};

const strictRules: ComplianceRules = {
  minOsVersion: { major: 15, minor: 0 },
  requirePassword: true,
  requireEncryption: true,
};

function report(partial: Partial<DeviceReport> & { sequence: number }): DeviceReport {
  return {
    osVersion: { major: 16, minor: 0 },
    passwordSet: true,
    encryptionOn: true,
    ...partial,
  };
}

interface DeferredEval {
  rules: ComplianceRules;
  report: DeviceReport;
  resolve: (compliant: boolean) => void;
}

/** 可手动控制完成时机与结果的评估器，用于精确编排异步时序。 */
function manualEvaluator() {
  const calls: DeferredEval[] = [];
  const evaluator: Evaluator = (rules, r) =>
    new Promise<boolean>((resolve) => {
      calls.push({ rules, report: r, resolve });
    });
  return { evaluator, calls };
}

/** 刷新微任务队列，让已解决的评估结论落定（其余未解决的评估继续等待）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("收紧规则后旧合规评估才结束，设备仍不能领取安装", async () => {
  const { evaluator, calls } = manualEvaluator();
  const m = new ComplianceModule({ initialRules: relaxedRules, evaluator });

  m.receiveReport("dev-1", report({ sequence: 1 }));
  m.registerInstallRequest("dev-1", { id: "req-1", payload: "app-a" });
  assert.equal(calls.length, 1);

  // 收紧规则：要求密码与加密。返回后立即隔离，旧评估尚未结束。
  m.editRules(strictRules);
  assert.equal(m.getDeviceState("dev-1").status, "pending");
  assert.equal(m.getDeviceState("dev-1").isolated, true);
  assert.equal(m.claimInstall("dev-1"), null);
  assert.equal(calls.length, 2);

  // 旧规则下的合规评估此刻才结束：结论迟到，必须被丢弃。
  calls[0].resolve(true);
  await flush();
  assert.equal(m.getDeviceState("dev-1").status, "pending");
  assert.equal(m.claimInstall("dev-1"), null);

  // 新评估结束：设备无密码报告不合规，请求继续保留但不能领取。
  calls[1].resolve(false);
  await flush();
  assert.equal(m.getDeviceState("dev-1").status, "non-compliant");
  assert.equal(m.getDeviceState("dev-1").isolated, true);
  assert.equal(m.claimInstall("dev-1"), null);
});

test("新报告通过评估后旧不合规评估才结束，设备不能被重新隔离", async () => {
  const { evaluator, calls } = manualEvaluator();
  const m = new ComplianceModule({ initialRules: strictRules, evaluator });

  m.receiveReport("dev-2", report({ sequence: 1, passwordSet: false }));
  m.registerInstallRequest("dev-2", { id: "req-1", payload: null });
  m.registerInstallRequest("dev-2", { id: "req-2", payload: null });
  assert.equal(calls.length, 1);

  // 新报告生效：仅该设备立即进入待评估并保持隔离。
  m.receiveReport("dev-2", report({ sequence: 2 }));
  assert.equal(m.getDeviceState("dev-2").status, "pending");
  assert.equal(m.claimInstall("dev-2"), null);
  assert.equal(calls.length, 2);

  // 新报告的评估先结束：合规，请求立即可领取。
  calls[1].resolve(true);
  await flush();
  assert.equal(m.getDeviceState("dev-2").status, "compliant");
  assert.equal(m.claimInstall("dev-2")?.id, "req-1");

  // 旧报告的不合规评估此刻才结束：结论迟到，不能重新隔离。
  calls[0].resolve(false);
  await flush();
  assert.equal(m.getDeviceState("dev-2").status, "compliant");
  assert.equal(m.getDeviceState("dev-2").isolated, false);
  assert.equal(m.claimInstall("dev-2")?.id, "req-2");
  assert.equal(m.claimInstall("dev-2"), null);
});

test("重复或较旧序号的报告不改变任何状态", async () => {
  const m = new ComplianceModule({ initialRules: relaxedRules });
  m.receiveReport("dev-3", report({ sequence: 5 }));
  await m.whenIdle();
  assert.equal(m.getDeviceState("dev-3").status, "compliant");

  assert.equal(m.receiveReport("dev-3", report({ sequence: 5 })), false);
  assert.equal(
    m.receiveReport("dev-3", report({ sequence: 3, passwordSet: false })),
    false
  );
  const state = m.getDeviceState("dev-3");
  assert.equal(state.status, "compliant");
  assert.equal(state.reportSequence, 5);
});

test("没有报告的设备始终隔离", () => {
  const m = new ComplianceModule({ initialRules: relaxedRules });
  m.registerInstallRequest("dev-4", { id: "req-1", payload: null });
  const state = m.getDeviceState("dev-4");
  assert.equal(state.hasReport, false);
  assert.equal(state.isolated, true);
  assert.equal(m.claimInstall("dev-4"), null);
});

test("规则编辑产生递增版本，恢复旧内容也属于新版本", () => {
  const m = new ComplianceModule({ initialRules: relaxedRules });
  assert.equal(m.editRules(strictRules), 2);
  assert.equal(m.editRules(relaxedRules), 3);
});

test("规则编辑后全体设备立即待评估，领取立即失效", async () => {
  const m = new ComplianceModule({ initialRules: relaxedRules });
  m.receiveReport("dev-5", report({ sequence: 1 }));
  m.receiveReport("dev-6", report({ sequence: 1 }));
  await m.whenIdle();
  m.registerInstallRequest("dev-5", { id: "req-5", payload: null });
  assert.ok(m.claimInstall("dev-5") !== null);

  m.registerInstallRequest("dev-5", { id: "req-5b", payload: null });
  m.registerInstallRequest("dev-6", { id: "req-6", payload: null });
  m.editRules(strictRules);
  // 同步生效：无需等待任何评估。
  assert.equal(m.claimInstall("dev-5"), null);
  assert.equal(m.claimInstall("dev-6"), null);
  assert.equal(m.getDeviceState("dev-5").status, "pending");
  assert.equal(m.getDeviceState("dev-6").status, "pending");
});

test("OS 版本按主、次版本数值逐段比较", async () => {
  const rules: ComplianceRules = {
    minOsVersion: { major: 15, minor: 0 },
    requirePassword: false,
    requireEncryption: false,
  };
  const m = new ComplianceModule({ initialRules: rules });
  m.receiveReport("low-minor", {
    osVersion: { major: 14, minor: 9 },
    passwordSet: false,
    encryptionOn: false,
    sequence: 1,
  });
  m.receiveReport("exact", {
    osVersion: { major: 15, minor: 0 },
    passwordSet: false,
    encryptionOn: false,
    sequence: 1,
  });
  await m.whenIdle();
  assert.equal(m.getDeviceState("low-minor").status, "non-compliant");
  assert.equal(m.getDeviceState("exact").status, "compliant");
});

test("判为不合规后请求继续保留，重新合规后原请求自动可领取", async () => {
  const m = new ComplianceModule({ initialRules: strictRules });
  m.receiveReport("dev-7", report({ sequence: 1, passwordSet: false }));
  await m.whenIdle();
  m.registerInstallRequest("dev-7", { id: "req-1", payload: "app-b" });
  assert.equal(m.claimInstall("dev-7"), null);

  m.receiveReport("dev-7", report({ sequence: 2 }));
  await m.whenIdle();
  assert.equal(m.getDeviceState("dev-7").status, "compliant");
  const claimed = m.claimInstall("dev-7");
  assert.equal(claimed?.id, "req-1");
  assert.equal(m.claimInstall("dev-7"), null);
});

test("非法 OS 版本被拒绝", () => {
  const m = new ComplianceModule({ initialRules: relaxedRules });
  assert.throws(() =>
    m.receiveReport("dev-8", {
      osVersion: { major: 15.5, minor: 0 },
      passwordSet: true,
      encryptionOn: true,
      sequence: 1,
    })
  );
  assert.throws(() =>
    m.editRules({
      minOsVersion: { major: -1, minor: 0 },
      requirePassword: false,
      requireEncryption: false,
    })
  );
});

# FleetGuard 合规隔离模块（iOS）

由上层调用的 TypeScript 库，提供四类操作：编辑规则、接收设备报告、登记安装请求、领取安装指令。

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { FleetGuard, DeviceStatus } from "fleetguard-compliance";

const fg = new FleetGuard(); // 可选：new FleetGuard({ evaluator }) 注入自定义异步评估器

fg.editRules({ minOsVersion: { major: 17, minor: 0 }, requirePassword: true, requireEncryption: true }); // => 新规则版本号
fg.receiveReport("device-1", { sequence: 1, osVersion: { major: 17, minor: 2 }, passwordSet: true, encryptionEnabled: true }); // => 是否生效
fg.registerInstallRequest("device-1", { app: "mail" }); // => InstallRequest
fg.claimInstallInstruction("device-1"); // => InstallInstruction | null
fg.getDeviceStatus("device-1"); // => DeviceStatus: isolated | pending_evaluation | compliant | non_compliant
```

## 语义要点

- 全体 iOS 设备共用一套规则；每次编辑（含恢复旧内容）产生新规则版本，全体设备立即进入待评估并保持隔离。
- 设备报告按单调递增序号生效，重复或较旧报告被忽略；新报告生效仅使该设备进入待评估。
- 评估为模块内异步工作；只有反映当前规则版本与当前报告的结论才能改变状态，迟到结论一律丢弃。
- 安装请求在隔离期间可登记保留；有效评估合规后自动具备领取资格，每次领取至多一条、每条最多领取一次。

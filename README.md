# task26100856

## FleetGuard 合规隔离模块（iOS）

TypeScript 库，由上层调用，提供四类操作：

- `editRules(rules)`：编辑全体设备共用的规则（最低 OS 版本 / 是否要求密码 / 是否要求加密），每次编辑产生新的规则版本。
- `receiveReport(deviceId, report)`：接收设备报告，仅更大序号生效。
- `registerInstallRequest(deviceId, request)`：登记安装请求，隔离期间也可登记并保留。
- `claimInstall(deviceId)`：领取安装指令，每次至多一条；仅当前有效评估判为合规时可领取。

另有 `getDeviceState(deviceId)` 观察待评估 / 合规 / 不合规与隔离状态，`whenIdle()` 等待已排期的异步评估落定。

评估为模块内异步工作：结论落定时若规则版本或设备报告已变化，则该迟到结论被丢弃。可通过构造函数注入自定义 `evaluator` 控制评估时序（测试即用此机制编排迟到结论）。

### 构建与测试

需要 Node.js ≥ 21，无其他服务依赖：

```sh
npm install
npm test
```

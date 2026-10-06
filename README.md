# ShipCycle 发布门禁模块

TypeScript 库，为上层应用提供发布门禁能力，数据持久化在 SQLite（Node 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 能力

- `initRelease`：初始化发布（Planning），指定至少一个组件与若干 Go-To-Market 清单项；组件关联此后固定。
- `applyBatch`：批量更新门禁事实（Bug 严重程度/状态、追加测试、设置期望状态、清单完成标记），整个批次在单个事务中生效。
- `previewGate`：查看门禁，返回可发布性、阻塞原因、对应依据与确认凭据。
- `confirmRelease`：携带仍有效的凭据确认发布；成功后保存 Released 状态与不可变的门禁依据，同一发布只能成功确认一次。

## 使用

```ts
import { ShipCycle } from "shipcycle-release-gate";

const sc = new ShipCycle("/path/to/gate.db");
await sc.initRelease({
  releaseId: "R1",
  componentIds: ["web", "api"],
  checklistItems: [{ itemId: "gtm-1", label: "官网更新" }],
});
await sc.applyBatch("R1", {
  expectationUpdates: [{ componentId: "web", expected: "Ready" }],
  tests: [{ componentId: "web", testId: "t1", passed: 97, total: 100, completedAt: Date.now() }],
  checklistUpdates: [{ itemId: "gtm-1", done: true }],
});
const preview = await sc.previewGate("R1");
if (preview.releasable) {
  const result = await sc.confirmRelease("R1", preview.token);
}
sc.close();
```

## 关键规则实现

- 实际状态由当前事实重算：存在 Open/In Progress 的 P0 Bug 则为 Blocked；期望 Ready 但最新测试不达标则为 In Progress；其余等于期望状态。自动阻塞不覆盖保存的期望状态。
- 最新测试取完成时间最晚者，完成时间相同取测试标识字典序最大者；通过率 = passed / total（skipped 计入分母），≥ 95% 达标，total 为 0 或无测试不达标。
- 凭据失效基于每发布的事实指纹（期望状态、最新测试、P0 阻塞集合、清单完成标记）：任何相关变化单调递增事实版本，改回原值也不能复用旧凭据；无关发布变更、未改变 P0 阻塞集合的 Bug 更新、未成为最新测试的迟到记录不影响指纹。
- 共享组件的 Bug 变化会使所有关联发布的指纹重算；已 Released 发布的门禁依据不再回写。
- 所有公开方法在单个同步区段内完成读写（`node:sqlite` 为同步驱动），同一进程内的并发调用等价于按某个完整顺序执行。

## 构建与测试

要求 Node.js ≥ 22.5（内置 `node:sqlite`）。

```sh
npm install
npm test
```

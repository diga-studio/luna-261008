# employee-evidence-store

本地员工证据库：用**加密粉碎（crypto-shredding）**解决"永久擦除"与"不可改写审计"的冲突。
纯 TypeScript / Node.js，仅使用本地文件持久化，无任何外部服务。

## 运行

```bash
npm install
npm test        # 编译并运行全部测试（含崩溃恢复与篡改检测）
npm run build   # 仅编译到 dist/
```

## 设计

### 冲突的解法

- 每个员工（`employeeId` 为随机标识）持有一把随机 AES-256-GCM 密钥（`keys/<id>.key`）。
- 该员工的全部敏感内容——事件数据文件与每条 ingest 审计项的自含载荷——都用这把钥匙加密。
- **擦除 = 销毁密钥 + 删除数据文件 + 写入永久禁写墓碑**。已提交的审计项逐字节保留，
  但其载荷永久无法解密；哈希链验证不受影响。
- ingest 审计项自含该次完整事件与提交时刻的累计每日汇总（加密后入链），不是指针或摘要。

### 审计链

`audit.log` 为追加式 JSONL。每项含 `seq`、`prevHash`、`type`、`employeeId`、`payload`、`hash`，
其中 `hash = sha256(JSON.stringify([seq, prevHash, type, employeeId, payload]))`。
已提交项永不修改、永不删除；篡改或删除中间项都会导致 `inspectAudit()` 的链验证失败。

### 目录布局（全部位于调用方指定目录）

```
audit.log            追加式哈希链审计日志
keys/<id>.key        员工密钥（擦除时删除）
data/<id>.enc        员工加密证据（事件 + 每日汇总，擦除时删除）
tombstones/<id>      永久禁写墓碑（擦除后 ingest 一律拒绝）
erase-pending/<id>   擦除进度标记（恢复用，完成后删除）
```

### 擦除协议与崩溃恢复

`eraseEmployee` 的持久化边界（每步完成后都可被强制终止）：

1. `start` — 尚未持久化任何内容；此前中断允许保持原状态。
2. `pending` — 写 `erase-pending/<id>` 进度标记。
3. `key` — 删除密钥文件。
4. `data` — 删除证据数据文件。
5. `tombstone` — 写永久禁写墓碑。
6. `audit` — 追加 erase-complete 审计项（仅当链上不存在该员工的完成项）。
7. `done` — 删除进度标记。

一旦 `pending` 标记落盘，之后任意时刻终止进程，`EvidenceStore.open()` 都会先幂等地
完成这次擦除，再开放读写：已删文件跳过、墓碑重写无害、完成审计项按 `employeeId` 去重，
因此永远只有一条 erase-complete 项，已接受的擦除绝不会回退。重复调用 `eraseEmployee`
命中墓碑直接返回，不产生第二条审计项。

### 不在威胁模型内

外部另存的擦除前副本、已释放磁盘扇区取证、断电与磁盘损坏（写调用返回即视为已持久化）。

## API

```ts
import { EvidenceStore } from "./src";

const store = EvidenceStore.open("/path/to/dir");   // 自动完成中断的擦除
store.ingest(employeeId, [{ timestamp, eventType, metadata }, ...]);
const { events, summaries } = store.readEmployee(employeeId);
store.eraseEmployee(employeeId);                    // 幂等
const { intact, problems, entries } = store.inspectAudit();
```

`inspectAudit()` 返回全局有序审计与完整性结论；未擦除员工的条目带解密后的完整载荷，
已擦除员工的条目标记 `payloadDestroyed: true`（载荷仍在链上但不可解密）。

## 测试（test/run.ts）

- 基本读写、UTC 按日汇总、审计项自含性、非法输入拒绝、重启持久化。
- 两名员工多次写入后擦除其一：逐字节比较此前全部已提交审计项（原内容为新文件前缀）、
  重复擦除无第二条完成项、禁写生效、无残留密钥/数据/临时文件、另一员工证据完整可读。
- 在 `eraseEmployee` 每个持久化边界对子进程发 `SIGKILL`，以同一目录重启，
  逐一验证彻底擦除、永久禁写、仅一条完成审计项（不用异常/finally 模拟终止）。
- 修改与删除历史中间审计项（含被擦除员工留下的项），完整性检查均失败。

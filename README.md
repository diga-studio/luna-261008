# employee-evidence-store

本地员工证据库：用密码学擦除（crypto-erasure）调和"永久擦除"与"不可改写审计"的冲突。
纯 TypeScript / Node.js，无外部服务，持久化只用本地文件。

## 设计

- **每员工一把数据密钥**：`keys/<id>.key` 保存 32 字节随机 AES-256-GCM 密钥。
  该员工的事件、每日汇总、以及 ingest 审计项的完整载荷全部用此密钥加密。
- **哈希链审计日志**：`audit.log` 为只追加 JSONL。每项含 `seq`、`prevHash`、`hash`
  （对密文载荷计算），已提交项的序号、载荷与校验材料永久不变；篡改或删除中间项
  会破坏链式校验。擦除后密钥已毁，历史 ingest 项成为无法解密的载荷，但哈希链
  仍可验证完整性。
- **擦除 = 毁钥 + 墓碑**：覆写并删除密钥文件、删除加密状态文件、写入永久禁写
  墓碑 `tombstones/<id>`、追加唯一一条 erase 审计项。内存中的密钥同时清零。
- **崩溃恢复**：擦除前先写 `pending-erase/<id>` 标记。构造 `EvidenceStore` 时
  若发现标记，先幂等地完成这次擦除（毁钥→删状态→墓碑→补审计项→删标记），
  再开放读写。已接受的擦除不会回退；完成审计项始终只有一条。

## 目录结构（调用方指定 dir）

```
audit.log            只追加哈希链审计日志
keys/<id>.key        每员工数据密钥（擦除时覆写并删除）
state/<id>.json      加密的员工状态（事件 + 每日汇总）
tombstones/<id>      永久禁写标记
pending-erase/<id>   擦除进行中标记（重启恢复的凭据）
```

## API

```ts
const store = new EvidenceStore({ dir });
store.ingest(employeeId, [{ timestamp, eventType, metadata }, ...]);
store.readEmployee(employeeId);   // { employeeId, events, summaries }
store.eraseEmployee(employeeId);  // 幂等；之后 ingest 该 id 抛错
store.inspectAudit();             // { items, integrityOk, integrityError }
```

## 构建与测试

```sh
npm install
npm test          # tsc 构建 + node --test（含子进程 SIGKILL 崩溃恢复测试）
```

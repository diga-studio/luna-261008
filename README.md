# VaultTerm

本地加密终端审计库：以追加写入的本地日志文件记录原始键击字节，内容使用
AES-256-GCM 加密，并通过哈希链与恢复元数据保证不可篡改。

## 使用

```ts
import { open } from "vaultterm";

// key 必须恰好 32 字节，且只用于该 sessionId。
const session = open(dir, key, sessionId);

const seq = session.append(eventId, bytes); // 从 1 开始的连续序号
session.seal();                             // 永久封存，重复调用无副作用
const records = session.read();             // 验证完整性并返回全部记录
```

- `append` 对同一 `eventId` 与相同字节的重试返回原序号；内容不同则抛出
  `EVENT_CONFLICT`。去重历史持久化在恢复元数据中，恢复后不丢失。
- 封存后新 `eventId` 被拒绝（`SESSION_SEALED`），已有事件的相同内容重试仍被接受。
- 认证失败或已提交数据缺失时，`open` 与 `read` 均抛出 `INTEGRITY_FAILURE`。

## 存储格式

每个会话两个文件，均位于 `dir` 下：

- `<sessionId>.log`：追加写入的日志主体，每行一条 JSON 记录。记录包含
  `seq`、`eventId`、`nonce`、`ct`、`tag`、`prev`、`hash`。
  `hash` 覆盖 sessionId、类型、序号、eventId、密文与上一条记录的哈希，
  形成哈希链；封存以一条特殊的 `seal` 记录落盘。
- `<sessionId>.meta.json`：恢复元数据（原子写入），包含 nonce 盐、记录数、
  链头哈希、封存状态与去重历史（eventId → 序号 + 内容哈希）。

## 完整性

- 密文使用 AES-256-GCM，AAD 绑定 sessionId、序号、记录类型与 eventId。
- nonce = 4 字节随机会话盐（持久化）‖ 8 字节大端序号，会话内绝不重复；
  按 API 约定密钥专属于单个会话，因此同一密钥下 nonce 不会复用。
- 打开与读取时重放整条哈希链并逐条验证 GCM 认证标签，可检出字节修改、
  删除、乱序、截断与跨会话替换；篡改日志而不同步改写恢复元数据同样会被拒绝。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 18）与 TypeScript，无原生模块与外部服务。

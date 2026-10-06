# VaultTerm

本地加密终端审计库：以追加式日志记录原始键击字节，AES-256-GCM 加密，
哈希链 + 恢复元数据保证完整性，支持会话恢复、事件去重与永久封存。

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { Vault } from "vaultterm";

const key = Buffer.alloc(32 /* 调用方持有的 32 字节会话密钥 */);
const vault = Vault.open({ dir: "./audit", key, sessionId: "session-1" });

const seq = vault.append("event-1", Buffer.from([0x1b, 0x5b, 0x41])); // 从 1 开始的连续序号
vault.append("event-1", Buffer.from([0x1b, 0x5b, 0x41]));             // 相同重试：返回原序号
// vault.append("event-1", Buffer.from("other"));                     // 内容不同：抛 VaultConflictError

const { records, sealed } = vault.read(); // 验证完整性并返回解密记录
vault.seal();                             // 永久封存，幂等
```

- `Vault.open({ dir, key, sessionId })`：首次创建会话，之后恢复同一会话；
  恢复时完整重放并验证日志，任何篡改、缺失或跨会话替换都会抛 `VaultIntegrityError`。
- `append(eventId, bytes)`：追加一条记录；同 `eventId` 同字节重试返回原序号，
  内容不同抛 `VaultConflictError`；封存后新 `eventId` 抛 `VaultSealedError`，
  已有事件的相同内容重试仍返回原序号。
- `seal()`：写入封存记录，永久关闭会话，重复调用无副作用。
- `read()`：重新验证磁盘上的日志与元数据后返回全部解密记录。

## 存储布局（dir 下）

- `vault.log`：追加式日志，每行一条 JSON 记录（事件或封存）。
  事件记录携带 AES-256-GCM 密文，AAD 绑定 `sessionId`、序号、`eventId` 与前序哈希；
  记录间以 SHA-256 哈希链串联，nonce 随机生成且会话内唯一。
- `vault.meta.json`：恢复元数据（`sessionId`、记录数、链头哈希、封存状态），
  原子写入；与日志不一致即拒绝恢复。

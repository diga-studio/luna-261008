# recommendation-letter-vault

奖学金推荐信接收库（TypeScript）。元数据存 SQLite（Node 内置 `node:sqlite`，无原生依赖），
PDF 字节存本地目录。

## 要求

- Node.js >= 22.13（`node:sqlite` 自该版本起免 flag）
- `npm install` 后 `npm test` 即可运行（构建 + 测试，无外部服务）

## API

```ts
import { LetterVault } from "recommendation-letter-vault";

const vault = new LetterVault({
  dbPath: "vault.db",        // 或 ":memory:"
  storageDir: "./letters",
  clock: () => Date.now(),   // 可注入，UTC 毫秒
});

const { token, expiresAt } = await vault.createToken(applicationId); // 14 天有效期
await vault.submit(token, asyncByteStream);   // AsyncIterable<Uint8Array>
const { status, stream } = await vault.read(token); // pending | submitted | expired
```

## 语义

- 一个 token 只对应一份不可变的已提交信件；未提交的失败尝试不消耗 token。
- 有效期在完整接收输入之后、写入 `submitted` 之前判定，判定时间必须严格早于 `expiresAt`。
- 已 `submitted` 的 token 永不因时间经过变为 `expired`。
- 已提交后重试：逐字节相同返回成功（幂等，即使已过有效期）；内容不同则拒绝且原信件不变。
- 输入流中途失败不留任何已提交状态（临时文件清理，元数据不变）。

## 脚本

- `npm run build` — 编译到 `dist/`
- `npm test` — 构建并运行 `node --test`

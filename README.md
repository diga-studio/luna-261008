# task26100828

奖学金推荐信接收库（TypeScript）。元数据存 SQLite（Node 内置 `node:sqlite`，零原生依赖），PDF 字节存本地目录。

## 要求

- Node.js >= 22.13（`node:sqlite` 免旗标）
- `npm install` 后 `npm test` 即可运行（先 `tsc` 编译再用 `node --test` 跑测试）

## API

```ts
import { RecommendationLetterLibrary } from "./src/index.js";

const lib = new RecommendationLetterLibrary({
  dbPath: "meta.sqlite",
  filesDir: "letters/",
  clock: () => Date.now(), // 可注入时钟，UTC 毫秒
});

const { token, expiresAt } = lib.createToken("application-123"); // 14 天有效期
await lib.submit(token, asyncByteStream); // 一次性异步字节流
const result = lib.read(token);
// result.status: "pending" | "submitted" | "expired"
// "submitted" 时 result.stream 为原始信件的可读字节流
```

语义要点：

- 有效期在完整接收输入之后、写入 `submitted` 之前判定，判定时间必须严格早于 `expiresAt`。
- 已 `submitted` 的 token 不再变为 `expired`；逐字节相同的内容重试幂等成功（即使已过期），不同内容拒绝且原信件不变。
- 读取输入流中途失败不留下已提交状态，未提交尝试不消耗 token。

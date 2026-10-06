# account-merge

客户账号合并库（TypeScript + SQLite），由上层业务直接调用。支持建立账号、追加历史、
合并账号、分页读取历史四项能力；账号编号仅在租户内唯一，合并后旧编号仍可定位到
当前主账号并继续追加历史，历史记录不可变且完整保留来源账号。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生编译依赖）

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { AccountMergeService } from "account-merge";

const svc = new AccountMergeService("./data.sqlite");
svc.createAccount("tenant-1", "A");
svc.appendHistory({
  tenantId: "tenant-1",
  accountId: "A",
  recordId: "r1",
  recordedAt: "2024-01-01T00:00:00Z",
  body: "consent ...",
});
svc.mergeAccounts("tenant-1", "B", "A"); // B 吸收 A；旧编号 A 仍可用
const page = svc.readHistory("tenant-1", "A", null, 50);
svc.close();
```

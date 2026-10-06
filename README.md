# guestconnect-merge

GuestConnect 离线会话合并与版本回退库，状态持久化到 SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.13（`node:sqlite` 免实验标志的最低版本）
- `npm install` 后 `npm test` 即可运行构建与全部测试

## API

```ts
import { GuestConnect } from "guestconnect-merge";

const gc = new GuestConnect("data.db"); // 或 ":memory:"

const v1 = gc.merge([
  { sessionId: "s1", sourceAp: "ap-a", sourceSeq: 1, updatedAt: 10, value: { k: "v" } },
  { sessionId: "s1", sourceAp: "ap-a", sourceSeq: 2, updatedAt: 30, value: null }, // 删除
]);

gc.read(v1, "s1");        // 读取指定版本的会话值；缺失或已删除返回 undefined
gc.rollback(1);           // 提交一个新版本，状态与版本 1 完全一致
gc.currentVersion;        // 最新版本号（0 为空状态）
gc.close();
```

## 语义

- **冲突比较**：`updatedAt` → `sourceAp` 字典序 → `sourceSeq`，大者胜；删除（`value: null`）以墓碑形式参与同一比较，阻止较旧更新复活会话。不做字段级合并。
- **去重**：事件身份为 `(sourceAp, sourceSeq)`。每个首次见到的事件都进入全局去重范围（无论是否赢得冲突），重复事件始终忽略。回退不恢复去重范围。
- **版本**：每次 `merge`/`rollback` 生成单调递增版本号（包括无状态变化的 merge）。版本 0 为空状态，任意已提交版本均可读取。
- **回退**：提交一个新版本，其会话状态（含冲突比较所需的获胜事件信息）与目标版本完全一致；被放弃分支上的版本仍可读取。
- **持久化**：版本、会话快照与去重集合全部存于 SQLite，正常关闭重开后保持一致。

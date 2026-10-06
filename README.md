# task26100871
# guestconnect-merge-store

GuestConnect 离线会话合并与版本回退库，状态持久化到 SQLite（Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { GuestConnectStore } from "guestconnect-merge-store";

const store = new GuestConnectStore("data.sqlite");

// 原子提交一批事件，返回新版本号；重复事件（sourceAp + sourceSeq）全局去重。
// 同一会话按 (updatedAt, sourceAp, sourceSeq) 比较，较大者胜出，删除同样参与比较。
const version: number = store.merge([
  { sessionId: "s1", sourceAp: "ap-a", sourceSeq: 1, updatedAt: 100, kind: "value", value: { tier: "gold" } },
  { sessionId: "s1", sourceAp: "ap-a", sourceSeq: 2, updatedAt: 200, kind: "delete" },
]);

// 读取任意已提交版本；版本 0 为空状态；不存在或已删除返回 undefined。
const value = store.read(version, "s1");

// 回退：生成一个新版本，其会话状态与目标版本完全一致（含冲突比较所需的获胜事件信息）。
// 去重范围不回退：被放弃分支上已处理的事件重传仍被忽略。
const newVersion = store.rollback(1);

store.currentVersion(); // 当前最新版本号
store.close();
```

## 持久化

所有版本历史、会话状态与去重记录都保存在单个 SQLite 文件中，关闭重开后完全一致。

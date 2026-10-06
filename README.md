# account-merge-store

客户账号合并库（TypeScript + SQLite）。运营团队可将重复客户账号归并到指定主账号，
同时保留完整的同意凭证与审计历史。

## 能力

- `createAccount(tenantId, accountId)`：在租户内建立账号，已存在则无效果成功。
- `appendHistory({ tenantId, accountId, recordId, recordedAt, body })`：追加不可变历史；
  `recordId` 租户内唯一；`accountId` 可为已合并的旧编号，记录进入当前账号组，
  `sourceAccountId` 保留提交时编号。
- `mergeAccounts(tenantId, primaryId, secondaryId)`：两个编号按当前归属解释；
  不同组则次方整组（账号及历史）归入主方，保留主方当前主账号；同组则无效果成功。
- `readHistory(tenantId, accountId, { cursor, limit })`：分页读取该组全部历史，
  按 `recordedAt` 升序、同时刻按 `recordId` 字典序；游标翻页恰好遍历全部记录一次。
- `resolveAccount(tenantId, accountId)`：解析任意旧编号当前归属的主账号。

账号编号只在租户内唯一；不同租户互不可见、不能合并（同组判断基于租户内归属）。

## 运行要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖、无外部服务）。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再用 node:test 跑 dist/test
npm run build   # 仅构建到 dist/
```

## 持久化

所有账号、合并归属与历史记录保存在单个 SQLite 文件中
（构造时传入 `filename`）。正常 `close()` 后重新打开，归属与历史保持一致。

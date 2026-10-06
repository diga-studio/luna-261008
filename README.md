# CostLens 流式账单导入库

以本地 SQLite 文件持久化的流式 CSV 账单导入库（TypeScript）。

## 使用

```ts
import { CostLens } from 'costlens-billing-import';

const lens = new CostLens('billing.db');

// chunks: AsyncIterable<Uint8Array>，字节块可切在任意位置
const result = await lens.importBilling(accountId, chunks);
if (result.ok) {
  console.log('imported', result.imported);
} else {
  console.log('row errors', result.errors); // [{ row, code }, ...] 按行号排列
}

for await (const record of lens.readBilling(accountId)) {
  // record: { resourceId, usageDate, usageQuantity, unitCost, totalCost }
  // 金额以原文精确读回（字符串，不经过浮点）
}

lens.close();
```

- 行级失败：返回 `{ ok: false, errors }`，错误含行号（数据行从 1 开始，按逻辑记录计数）与稳定错误代码；整批拒绝，已存账单不变。
- 文件级失败（CSV 语法损坏、无效 UTF-8、错误表头、记录超 64 KiB、输入流异常）：抛出 `ImportFileError`（含 `code`），全部写入撤销。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 23.4，内置 `node:sqlite` 与 `node:test` 均免 flag）和 devDependency `typescript`。

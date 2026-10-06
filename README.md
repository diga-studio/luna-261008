# CostLens 流式账单导入库

TypeScript 实现的流式 CSV 账单导入库，使用本地 SQLite 文件持久化（Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 23.4（内置 `node:sqlite`，无需任何系统服务）

## 构建与测试

```sh
npm install
npm test        # tsc 编译后运行 node:test 测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { CostLens } from "costlens-billing-import";

const lens = new CostLens("billing.db");

// 导入：chunks 为 AsyncIterable<Uint8Array>
const result = await lens.importBilling(accountId, chunks);
// 成功:  { status: "ok", imported: number }
// 行级失败: { status: "row_errors", errors: [{ line, code }, ...] }（按行号排列，全部回滚）
// 文件级失败: 抛出 FileImportError（code 为 INVALID_UTF8 / CSV_SYNTAX /
//             RECORD_TOO_LARGE / HEADER_MISMATCH / STREAM_ERROR），全部回滚

// 读取：逐条返回该账户已提交的账单，金额为精确十进制文本
for await (const rec of lens.readBilling(accountId)) {
  // { resourceId, usageDate, quantity, unitCost, totalCost }
}

await lens.close();
```

同一实例上的所有调用通过内部互斥锁串行执行。

## 设计要点

- **字节级 CSV 解析**（`src/csvParser.ts`）：状态机直接作用于字节，分隔符/引号/CR/LF
  均为 ASCII，UTF-8 多字节序列不会与之冲突，因此字节块可以切在任意位置
  （多字节字符、CRLF、转义双引号中间）。记录在完整时按严格 UTF-8 解码，
  单条逻辑记录上限 64 KiB。
- **精确十进制**（`src/decimal.ts`）：金额解析为 `BigInt` 缩放整数，
  `total_cost = round_half_even(quantity × unit_cost)` 用整数运算校验，
  不使用二进制浮点。数据库中以原始文本存储，读回逐字节精确。
- **事务性导入**（`src/costlens.ts` + `src/store.ts`）：整个导入在一个
  SQLite 事务中执行。批内去重通过 TEMP 表 `batch_keys` 完成（内存不随
  行数增长）；已存数据通过唯一索引检查。任一行级错误 → 整体 ROLLBACK；
  文件级失败同样 ROLLBACK。
- **行级错误代码**：`FIELD_COUNT`、`EMPTY_RESOURCE_ID`、`INVALID_DATE`、
  `INVALID_QUANTITY`、`INVALID_UNIT_COST`、`INVALID_TOTAL_COST`、
  `TOTAL_MISMATCH`、`DUPLICATE_KEY`。同一行的多个错误全部报告，
  出错后继续读取后续记录。

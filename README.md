# review-csv-importer

评论 CSV 导入库（TypeScript），评论持久化到 SQLite。由上层直接调用，无接口层。

## 要求

- Node.js >= 22.18（使用内置 `node:sqlite` 与原生 TypeScript 类型擦除运行）
- 无运行时依赖

## 使用

```ts
import { createReviewLibrary } from './src/index.ts';

const lib = createReviewLibrary('reviews.db');

// 导入（merchantId 为可信商家标识，bytes 为一次性字节流）
const result = lib.importCsv('merchant-1', bytes);
// result.status: 'ok' | 'rejected' | 'failed'
//   - ok:       已提交，errors 中为被跳过的错误记录
//   - rejected: 错误率超过 15%，整批拒绝，已有数据不变
//   - failed:   结构性错误（非法 UTF-8 / 表头不符 / 引号结构错误 / 未闭合引号 / 孤立 CR），已有数据不变

// 读取该商家的评论（完整原始字段）
const reviews = lib.listReviews('merchant-1');

lib.close();
```

## CSV 格式

- UTF-8，开头允许一个 BOM；表头固定为 `channel,reviewer_name,text,timestamp`
- 逗号分隔，记录以 LF 或 CRLF 结束，最后一条记录可没有换行
- 双引号包围的字段允许逗号和换行，引号用 `""` 表示；结束引号后只允许分隔符、记录结束或文件结束
- 未引用字段不能含双引号；单独出现的 CR 不合法
- `timestamp` 为带时区的 RFC3339 时间（最多 3 位小数，秒不为 60，日期真实存在）

## 导入语义

- 去重键 = 商家标识 + channel + reviewer_name + timestamp；
  channel/reviewer_name 去首尾 ASCII 空格并做 Unicode NFC 归一（区分大小写），时间归一为 UTC 毫秒
- 相同键只保留批次中最后一条有效记录的完整原始字段，并替换库中已有记录；不同商家永不合并
- 记录级错误（字段数不为 4、空行、timestamp 不合法、channel/reviewer_name 归一后为空）可跳过；
  错误率 = 错误记录数 / 全部数据记录数，恰好 15% 允许提交，超过 15% 整批拒绝
- 任何整批失败或拒绝都不会修改已有数据；只有表头的文件视为空批次，成功但不修改数据

## 脚本

- `npm test` — 运行测试（node:test，零依赖）
- `npm run typecheck` — TypeScript 类型检查（需先 `npm install`）

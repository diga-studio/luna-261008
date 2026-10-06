# review-csv-importer

评论 CSV 导入库（TypeScript）：由上层服务调用，评论持久化到 SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试（先 `tsc` 构建再用 `node --test` 跑）

## API

```ts
import { ReviewStore, importReviews } from 'review-csv-importer';

const store = new ReviewStore('reviews.db'); // SQLite 文件路径，':memory:' 亦可

// 导入：merchantId 为可信商家标识；stream 为一次性字节流（AsyncIterable<Uint8Array>，
// Node 的 Readable 可直接传入）
const result = await importReviews(store, merchantId, stream);
// result.status: 'imported' | 'rejected' | 'failed'
//   - imported: 成功提交（错误率 <= 15%，只跳过错误记录；空批次也算成功）
//   - rejected: 错误率 > 15%，整批拒绝，已有数据完全不变
//   - failed:   非法 UTF-8 / 表头不符 / 引号结构错误 / 引号未闭合，已有数据完全不变
// result 还包含 totalRecords / errorRecords / errors[{recordIndex, reason}] / upserted

// 读取：返回该商家全部评论（完整原始字段），按时间升序
const reviews = store.listReviews(merchantId);

store.close();
```

## 格式与规则

- UTF-8，开头允许一个 BOM；表头固定为 `channel,reviewer_name,text,timestamp`
- 逗号分隔，记录以 LF 或 CRLF 结束，最后一条记录可没有换行
- 双引号包围的字段允许逗号和换行，`""` 表示一个字面双引号；结束引号后只允许分隔符、记录结束或文件结束
- 未引用字段不能含双引号；单独出现的 CR 不合法
- timestamp 为带时区的 RFC3339（最多 3 位小数，秒不为 60，日期真实存在）
- 去重键 = 商家标识 + channel + reviewer_name + timestamp；channel/reviewer_name 去首尾 ASCII 空格后做 NFC（区分大小写），时间归一为 UTC 毫秒
- 相同键只保留批次中最后一条有效记录的完整原始字段，并替换库中已有记录；错误记录不能覆盖有效记录
- 错误率 = 错误记录数 / 全部数据记录数（重复记录计入分母）；恰好 15% 允许提交，超过则整批拒绝
- 任何整批失败/拒绝都在事务外完成判定或整体回滚，已有评论完全不变

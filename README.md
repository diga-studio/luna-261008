# criminal-record-screening

供 HR 后台直接调用的刑事记录候选筛查库（TypeScript）。支持刑录数据集导入（持久化到本地 JSON 文件）与批量员工筛查，筛查期间数据集固定。

## 安装与测试

```sh
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 devDependencies 中的 typescript / @types/node，不需要数据库或任何常驻服务。

## 匹配规则

1. **身份冲突排除**：双方都有出生日期但不同，或双方 SSN 已知的对应位（右对齐，9 位对末 4 位时只比末 4 位）存在差异，则该配对不命中。缺失值既不构成冲突，也不能作为相等证据。
2. **分类**（按优先级，同一配对只取最高类别）：
   - `exact`：双方完整 9 位 SSN 相同；
   - `partial`：出生日期相同且姓名键全串完全相同；
   - `fuzzy`：出生日期相同且姓名键的 Levenshtein 编辑距离 ≤ 2（仅单字符插入/删除/替换各计 1，交换相邻字符不算一次修改）。

## 使用示例

```ts
import { DatasetStore, screenEmployees } from "criminal-record-screening";

// 导入 HR 上传的本地刑录数据（整体替换并持久化到本地文件）
const store = new DatasetStore("./data/criminal-records.json");
store.importRecords([
  { id: "R1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" },
  { id: "R2", nameKey: "zhangsan", birthDate: "1990-01-01" },
]);

// 批量筛查：取一次快照，筛查期间数据集固定
const results = screenEmployees(
  [{ id: "E1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }],
  store.snapshot(),
);
// results[0].hits === [
//   { recordId: "R1", category: "exact" },
//   { recordId: "R2", category: "partial" },
// ]
```

## 数据约定

- `id`：人员与刑录各自的独立标识；不同标识的刑录即使字段相同也分别保留，同一刑录可同时命中多位员工。
- `nameKey`：姓名键，已由上游规范为小写英文字母串。
- `birthDate`：`YYYY-MM-DD`，可缺失。
- `ssn`：完整 9 位数字、仅末 4 位数字，或缺失；其他格式会在匹配时抛出错误。

## 目录结构

- `src/types.ts`：数据与结果类型定义
- `src/editDistance.ts`：Levenshtein 编辑距离（带 max 截断）
- `src/matcher.ts`：单配对冲突排除与分类
- `src/store.ts`：数据集导入与本地 JSON 文件持久化
- `src/screening.ts`：批量员工筛查
- `test/`：自动化测试（node:test）

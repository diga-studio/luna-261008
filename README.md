# task26100846
# criminal-record-screening

HR 后台直接调用的刑事记录候选筛查库（TypeScript）。导入的刑录数据集持久化在本地 JSON 文件中，筛查期间数据集固定。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

## 用法

```ts
import { DatasetStore, screenEmployees } from "criminal-record-screening";

const store = new DatasetStore("/path/to/dataset.json");
store.importRecords([
  { id: "R1", nameKey: "johnsmith", dob: "1980-01-01", ssn: { kind: "full", value: "123456789" } },
]);

const results = screenEmployees(store, [
  { id: "E1", nameKey: "johnsmyth", dob: "1980-01-01" },
]);
// results: [{ employeeId: "E1", matches: [{ recordId: "R1", category: "fuzzy" }] }]
```

## 匹配规则

- **冲突排除**：双方都有出生日期但不同，或双方 SSN 已知对应位（完整 9 位对齐末 4 位）存在差异，则该配对不命中；缺失值既不冲突也不构成相等证据。
- **exact**：双方完整 9 位 SSN 相同。
- **partial**：出生日期相同且姓名键完全相等。
- **fuzzy**：出生日期相同且姓名键的标准 Levenshtein 距离 ≤ 2（插入/删除/替换各计 1，相邻交换不算一次修改）。
- 每位员工返回全部命中刑录的标识及最高类别；不同标识的刑录分别保留，同一刑录可命中多位员工。

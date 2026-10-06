# task26100820
# doc-field-extract

纯内存的文档字段抽取库（TypeScript）。输入按页排列的原始 Unicode 文本与字段规则，
输出所有非空字段候选及其在原文中的可追溯证据区间。

## 使用

```ts
import { extractFields } from "doc-field-extract";

const candidates = extractFields(
  ["page one text", "page two text"],
  [
    {
      name: "amount",
      anchor: "Total:",            // 字面量锚点，按文档相同规则归一化
      pattern: /(?<value>[\d.]+)/, // 必须含 (?<value>...) 命名捕获组
    },
  ],
);
// candidates: [{ field, value, page, anchorSpan, valueSpan }, ...]
// span 为半开区间，按该页原文的 UTF-16 代码单元计数，可直接 slice 原文取证。
```

## 规则要点

- 每页独立处理：NFKC 归一化 → 删除软连字符 U+00AD → 连续的 Unicode
  White_Space 折叠为一个普通空格（首尾折叠空格保留），页与页之间不连接。
- 锚点从左至右非重叠识别；锚点结束到下一同规则锚点开始（或页尾）构成
  独立搜索区域，区域内在归一化文本上执行 Unicode 全局正则匹配。
- 返回所有非空的归一化 `value`，不做择优；`value` 按捕获组实际位置定位
  （含前瞻/后顾内的捕获），不用整体匹配范围代替。
- 证据区间是覆盖所有贡献字符的最小连续原文区间，并完整包含其所属的
  扩展字素簇；被删除的软连字符仅在区间内部时被覆盖。

## 开发

```sh
npm install
npm test   # tsc 构建后用 node:test 运行全部测试
```

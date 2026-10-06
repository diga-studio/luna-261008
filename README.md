# community-moderation

社区内容审核定位库（TypeScript）。词库从本地文件加载，待检查内容只在内存中处理。

## 能力

- `loadChecker(wordlistPath)`：从本地文件加载词库（每行一个词条，空行与 `#` 开头的行忽略），返回检查器。
- `createChecker(words)`：直接由词条数组创建检查器。
- `checker.check(content)`：检查一段 CommonMark 文本，返回全部命中。

## 匹配语义

- 输入遵循 CommonMark 0.31.2（段落、强调、行内链接、转义、实体、行内代码、围栏代码块）。
- 检查渲染后的可见文字：强调内容与链接标签参与匹配；链接地址、行内代码与围栏代码块不参与。
- 段落、可见文本中的换行、代码区域均为匹配边界，两侧不拼接；相邻可见文字跨格式节点连贯匹配。
- 转义与实体按 CommonMark 解码；随后忽略 U+200B / U+200C / U+200D / U+FEFF，
  再对每个扩展字素簇执行 NFKC 与不依赖区域设置的小写转换后匹配。
- 返回全部命中：包括互相重叠的词条与同一词条的每次出现，不去重。

## 命中位置

每个命中返回词条原文与一组原文位置（UTF-16 代码单元计数的半开区间）：

- 区间覆盖参与命中的完整原字素簇（一个原字符展开成多个字符时覆盖整个原字符）。
- 区间可以不连续，按原文顺序排列，重叠或紧邻的区间已合并。
- 格式标记、链接地址、被忽略的不可见字符不会被框入；贡献了可见字符的转义或实体覆盖其完整原文范围。
- 区间不会切断代理对。

## 示例

```ts
import { loadChecker } from "community-moderation";

const checker = await loadChecker("./words.txt");
const hits = checker.check("买**彩[票](https://example.com)网**站");
// hits: [{ word: "彩票", ranges: [...] }, { word: "票网", ranges: [...] }, ...]
```

## 开发

```sh
npm install
npm test     # 类型检查 + 运行测试
npm run build
```

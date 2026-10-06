# community-content-moderation

社区内容审核定位库（TypeScript）。词库从本地文件加载，待检查内容只在内存中处理；
对 CommonMark 渲染后的可见文字做敏感词匹配，并把命中精确映回 Markdown 原文的
UTF-16 半开区间，供审核员在原文编辑器里标注。

## 使用

```ts
import { loadLexicon, checkContent } from 'community-content-moderation';

const lexicon = loadLexicon('words.txt');      // 本地词库文件：一行一个词
const hits = checkContent(lexicon, postMarkdown);
// hits: Array<{ word: string; ranges: Array<{ start: number; end: number }> }>
```

- `loadLexicon(filePath)`：读取本地词库文件（UTF-8，一行一个词条，空行跳过、
  重复词条去除）。词条按纯文本处理，不解释为 Markdown。
- `checkContent(lexicon, content)`：返回全部命中，包括互相重叠的词条与同一词条
  的每次出现；不做去重。`ranges` 按原文顺序排列，重叠或紧邻的区间已合并，
  可能不连续（格式标记、链接地址、被忽略的不可见字符不会被框入）。

## 匹配规则

- 输入遵循 CommonMark 0.31.2（段落、强调、行内链接、转义、实体、行内代码、
  围栏代码块）。检查渲染后的可见文字：强调内容与链接标签参与匹配，链接地址与
  代码内容不参与。段落、可见文本中的换行、代码区域都是匹配边界。
- 转义与实体按 CommonMark 解码；随后忽略 U+200B / U+200C / U+200D / U+FEFF，
  再对每个扩展字素簇分别做 NFKC 与（不依赖区域设置的）小写转换后匹配。
- 命中区间覆盖参与命中的完整原字素簇；一个原字符展开成多个字符时，即使只命中
  其中一个也覆盖整个原字符；区间不会切断代理对。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 18）与 `package.json` 中声明的 npm 包，无需任何外部服务。

## 目录结构

- `src/markdown.ts`：CommonMark 解析与可见文字段提取（含转义/实体解码、边界切分）
- `src/normalize.ts`：不可见字符剔除、字素簇切分、NFKC + 小写归一化
- `src/matcher.ts`：Aho-Corasick 多模式匹配与区间合并
- `src/lexicon.ts`：词库加载与归一化
- `src/index.ts`：对外 API（`loadLexicon` / `checkContent`）
- `test/`：自动化测试（`node:test`）
- `tools/offline-install.mjs`：仅本仓库开发环境使用的离线安装辅助脚本，
  干净机器上不需要（直接 `npm install` 即可）

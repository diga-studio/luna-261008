# task26100847 — PhishGuard 流式 MIME 威胁扫描组件

从原始邮件字节流中还原纯文本正文并匹配关键词规则，全程流式处理，
工作内存不随正文长度增长。

## 用法

```ts
import { createScanner } from "./src";

const scanner = createScanner([
  { id: "kw1", needle: "威胁关键词", weight: 40 },
  { id: "kw2", needle: "secret", weight: 30 },
]);

for (const chunk of chunks) {
  const newHits: string[] = scanner.write(chunk); // 本次新命中的规则 id
}
const { hitIds, score, quarantined } = scanner.finish();
```

- `score` 为不同命中规则的 weight 之和，上限 100；`score >= 70` 时 `quarantined` 为真。
- 同一规则 id 整封邮件只报告一次。
- 未闭合的 multipart 在 `finish()`（或外层边界提前出现的 `write()`）时报错。

## 支持范围

- CRLF 换行、ASCII 首部；首部名称 / 媒体类型 / 传输编码名称大小写不敏感；
  支持首部折叠、带引号参数、引号内反斜线转义。
- 任意 multipart 类型，最多嵌套 8 层；分部首部不超过 8 KiB；boundary 为
  不超过 70 字符的 ASCII 字符串，大小写敏感；分隔行允许尾随空格 / 制表符。
- 只扫描 `text/plain` 叶子；Content-Type 缺省 `text/plain`，charset 缺省
  `US-ASCII`；支持 US-ASCII 与 UTF-8，以及 7bit / 8bit / base64 /
  quoted-printable（缺省 7bit）。
- 每个叶子匹配上下文独立；同一叶子内的命中可跨输入块、编码组与 UTF-8 字符边界。

## 结构

- `src/types.ts` — 公开类型（Rule / Scanner / ScanResult）
- `src/matcher.ts` — Aho-Corasick 流式关键词匹配器
- `src/decode.ts` — 流式传输解码（base64 / quoted-printable）与字符集解码（US-ASCII / UTF-8）
- `src/headers.ts` — 首部展开与 Content-Type 参数解析
- `src/mime.ts` — 流式 MIME 结构解析（嵌套 multipart、边界检测、叶子解码管线）
- `src/scanner.ts` — `createScanner` 编排与计分

## 构建与测试

```sh
npm install
npm test
```

测试覆盖：逐字节位置两段切分与单字节 chunk 的命中一致性、假边界前缀 /
解码后才出现的边界 / 被忽略的二进制分部 / 跨叶子关键词片段、20 MiB 长正文的
流式命中与未闭合 multipart 报错、首部与嵌套深度限制等。

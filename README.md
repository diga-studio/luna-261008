# PhishGuard 流式 MIME 威胁扫描组件

从原始邮件字节中流式还原纯文本正文并匹配关键词规则。

## 使用

```ts
import { createScanner } from "./src/scanner.js";

const scanner = createScanner([
  { id: "rule-1", needle: "机密keyword", weight: 40 },
]);
for (const chunk of chunks) {
  const newHits: string[] = scanner.write(chunk); // 本次新命中的规则 id
}
const { hitIds, score, quarantined } = scanner.finish();
```

- `createScanner(rules)`：规则需 id 唯一、needle 非空、weight 为正整数。
- `write(bytes)`：接受任意大小的 `Uint8Array`（含空块），同步返回新命中。
- `finish()`：`score` 为不同命中规则 weight 之和（上限 100），`score >= 70` 时
  `quarantined` 为真；未闭合的 multipart 会抛错。

## 支持范围

- CRLF 换行、ASCII 首部；首部名称 / 媒体类型 / 编码名称大小写不敏感；
  支持首部折叠、带引号参数与引号内反斜线转义。
- 任意 multipart 类型，最多嵌套 8 层；分部首部不超过 8 KiB；
  boundary 为不超过 70 字符的 ASCII 字符串，大小写敏感。
- 只扫描 `text/plain` 叶子；缺省 `text/plain` + `us-ascii` + `7bit`；
  支持 `us-ascii` / `utf-8` 与 `7bit` / `8bit` / `base64` / `quoted-printable`。
- 流式处理：内存随规则规模、首部上限与嵌套深度增长，不随正文长度增长。

## 构建与测试

```sh
npm install
npm test        # tsc 编译后运行 node --test
```

仅依赖 Node.js（>= 18）与 devDependencies 中的 TypeScript。

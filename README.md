# dns-message-parser

面向边缘防护引擎的 DNS 消息解析库（TypeScript）。输入为单个 DNS 消息（不含传输层封装），
解析头部、问题区及答案/权威/附加三个资源记录区。

## 特性

- 域名以标签字节数组表示，保留大小写与任意八位字节；根域名为空列表。
- 压缩指针只能指向更早且已完整解析的名字中的标签首字节、指针首字节或根终止字节；
  报文头、普通字段、标签内容、不透明 RDATA 均不能成为指针目标。
- 展开后名称编码长度（含各长度字节与根终止字节）不得超过 255。
- 仅结构化解析 CNAME（类型 5）与 SOA（类型 6）的 RDATA；其余类型保留原始字节。
- 任何结构错误都会使整个解析失败并抛出 `DnsParseError`，不返回部分结果。

## 使用

```ts
import { parseMessage } from "dns-message-parser";

const message = parseMessage(bytes); // bytes: Uint8Array
```

## 构建与测试

```sh
npm install
npm test
```

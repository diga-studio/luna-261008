# pipeforge-local

PipeForge 的本地版本交付库（TypeScript）。输入为已传输完成的不可变源文件，所有业务调用串行。

## 使用

```ts
import { PipeForge } from "./src";

const pf = new PipeForge("/var/lib/pipeforge"); // 持久化根目录（本地文件）

// 发布：把源文件发布为逻辑输出的新版本，返回版本号（从 1 开始连续递增）
const v = await pf.publish("site-bundle", "req-001", "/tmp/artifact.tar");

// 回滚：以仍保留的历史版本内容发布新版本，不修改原版本
const v2 = await pf.rollback("site-bundle", "req-002", 1);

// 查看当前交付文件与所有保留版本（含 SHA-256 与大小）
const info = await pf.inspect("site-bundle");
```

## 语义

- 每个输出的版本号从 1 开始，已提交版本连续递增。
- 成功后只保留最近 20 个版本（含当前版本），更早的版本文件被淘汰。
- 当前交付路径（`inspect` 返回的 `currentPath`）保持稳定，始终指向普通文件，
  字节与当前版本一致；写入采用临时文件 + rename 的原子方式。
- 所有保留版本均可逐字节读回并通过 SHA-256 验证（rollback 读取时会强制校验）。
- `requestId` 在同一输出内永久幂等：已提交请求的相同参数重试返回原版本号，
  不追加版本、不改变当前交付文件，即使原版本/回滚目标已被淘汰；
  相同 `requestId` 但参数不同会抛错。请求记录持久化在 `meta.json` 中，重启后仍有效。

## 存储布局

```
<rootDir>/outputs/<encodeURIComponent(output)>/
  current          # 当前交付文件（稳定路径，普通文件）
  versions/<n>     # 保留的历史版本（最多 20 个）
  meta.json        # 版本列表 + 永久幂等请求记录
```

## 构建与测试

只依赖 Node.js：`npm install` 后 `npm test` 即可运行（tsc 编译 + node:test）。

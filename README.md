# change-impact-tracer

进程内存中的变更影响追溯库，由上层工程管理工具直接调用（无接口层、无外部服务）。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`typescript` 与 `@types/node` 为 devDependencies，测试使用 Node 内置 `node:test`。

## 用法

```ts
import { ImpactTraceLibrary } from 'change-impact-tracer';

const lib = new ImpactTraceLibrary();

// 装载追溯图（制品含 requirement / test / design-doc / change-request）
lib.loadGraph(artifacts, links);

// 批量增删链接（会使已有分析结果失效）
lib.addLinks([{ from: 'REQ-1', to: 'DSN-9' }]);
lib.removeLinks([{ from: 'REQ-1', to: 'DSN-9' }]);

// 针对本批变更需求执行分析（完全基于当前图与当前批次）
lib.analyze(['REQ-1', 'REQ-2']);

// 查询结果
lib.getAffectedArtifacts();   // 受影响制品名单（来源集合非空）
lib.getSourcesOf('TST-3');    // 任一制品的完整来源集合
```

## 语义

- 有向链接 `A -> B` 表示 A 变更可能影响 B，可跨制品类型，允许循环。
- 只有本批选定的需求是变更来源；来源沿有向链接可达的制品（含来源自身）都记录该来源。
- 多路径到达同一制品时同一来源只出现一次；不同来源全部保留。
- 每次分析完全反映当前图与当前批次，不残留旧批次或已断开通路的来源。

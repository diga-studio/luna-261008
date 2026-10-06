# task26100824

变更影响追溯库（TypeScript，纯进程内存，无接口层）。上层工程管理工具直接引用 `src/index.ts` 导出的 API。

## 用法

```ts
import { TraceGraph, analyzeImpact } from './src/index.js';

const graph = new TraceGraph();
graph.load(
  [{ id: 'R1', type: 'requirement' }, { id: 'T1', type: 'test' }],
  [{ from: 'R1', to: 'T1' }],   // R1 变更可能影响 T1
);
graph.addLinks([{ from: 'T1', to: 'D1' }]);
graph.removeLinks([{ from: 'T1', to: 'D1' }]);

const result = analyzeImpact(graph, ['R1']); // 本批变更需求
result.affectedArtifacts();                  // 受影响制品名单
result.sourcesOf('T1');                      // T1 的完整来源集合
```

- 每次 `analyzeImpact` 基于当前图与当前批次全量重算，返回不可变快照。
- 来源自身计入受影响名单；只有来源集合非空的制品才进入名单。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `devDependencies` 中的 `typescript` / `@types/node`。

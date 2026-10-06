# doc-workflow-runtime

内存态文档工作流运行库（TypeScript），由上层直接调用。工作流以 JSON 传入，
支持条件分流/汇合、低置信度人工复核、失败重试。

## 使用

```bash
npm install
npm test        # 运行自动化测试
npm run build   # 编译到 dist/
```

## API

```ts
import { WorkflowEngine } from "doc-workflow-runtime";

const engine = new WorkflowEngine({
  process: { /* 节点id -> 异步处理器 */ },
  condition: { /* 节点id -> 异步处理器 */ },
});

// 1. 启动文档运行（fields 为已提取的文档字段）
const runId = engine.startRun(workflow, fields);

// 2. 提交复核结果（修正字段整体替代原结果；首个提交生效，重复提交返回 false）
engine.submitReview(runId, taskId, { /* corrected fields */ });

// 3. 读取运行及复核任务快照
const snapshot = engine.getSnapshot(runId);
```

## 工作流定义

```ts
{
  entry: "entry",
  nodes: [
    { id: "entry", type: "process" },
    { id: "route", type: "condition" },
    // ...
  ],
  edges: [{ from: "entry", to: "route" } /* ... */],
}
```

- 普通节点（`process`）成功后选择全部出边；条件节点（`condition`）通过
  处理器返回的 `select: string[]` 选择任意后继子集（含空集），其余出边排除。
- 节点须等全部入边确定：至少一条选中才执行（输入为所有选中前驱输出的合并），
  全部排除则跳过并将其出边全部排除。
- 普通节点结果可附 `confidence`（0-100）；低于 70 生成复核任务，结果暂不发布，
  复核提交后整体替代并继续推进；其余直接发布。
- 处理器失败后按 2s / 8s / 32s 重试，第四次失败使整次运行失败；失败后不再
  启动新步骤，迟到结果与复核提交均被忽略。

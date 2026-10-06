# doc-workflow-runner

内存态文档工作流运行库（TypeScript），由上层直接调用。工作流以 JSON 传入，运行状态全部保存在内存中。

## 构建与测试

```bash
npm install
npm test        # 编译 src+test 后用 node:test 运行全部测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与 devDependencies 中的 `typescript`、`@types/node`，无需任何外部服务。

## API

```ts
import { WorkflowRunner } from "doc-workflow-runner";

const runner = new WorkflowRunner(); // 可注入 { retryDelaysMs, sleep } 便于测试

// 1. 启动文档运行
const { runId } = runner.startRun(workflow, handlers, extractedFields);

// 2. 提交复核结果（首个提交生效，重复/冲突提交返回 accepted: false）
runner.submitReview(runId, taskId, correctedFields);

// 3. 读取运行及复核任务快照
const snapshot = runner.getRunSnapshot(runId);

// 辅助：等待运行进入终态
const final = await runner.whenSettled(runId);
```

## 工作流定义

```jsonc
{
  "entry": "extract",            // 唯一入口，接收已提取的文档字段
  "nodes": [
    { "id": "extract", "kind": "process" },
    { "id": "route",   "kind": "condition" }
  ],
  "edges": [{ "from": "extract", "to": "route" }]
}
```

- 节点仅 `process`（普通处理）与 `condition`（条件分支）两类，处理器由上层以异步函数提供。
- 输入保证无环、唯一入口、所有节点从入口可达；运行期间工作流不变。

## 处理器

```ts
type ProcessHandler  = (input) => Promise<{ output: unknown; confidence?: number }>;
type ConditionHandler = (input) => Promise<{ output?: unknown; select: string[] }>;
```

- 非入口节点的 `input` 为 `{ 选中前驱id: 该前驱最终输出 }`；入口节点为文档字段本身。
- 普通节点成功后选择全部出边；条件节点按 `select` 选择后继子集（可为空集），其余出边排除。
- 节点等全部入边确定后才决定：至少一条选中则执行；全部排除则跳过（跳过节点无输出，其出边全部排除，共享后继仍可被其他路径激活）。
- 所有节点成功或跳过后，运行成功。

## 复核

- 普通处理器返回 `confidence < 70` 时生成复核任务，结果暂不发布，节点保持未完成；其余分支照常推进。
- `submitReview` 的修正字段整体替代原结果，节点随后成功并发布输出。
- 首个提交生效；重复或冲突提交返回 `{ accepted: false }`，不覆盖也不再次推进后继。

## 重试与失败

- 处理器失败后最多重试三次，默认分别在失败结束后等待 2、8、32 秒（可用 `retryDelaysMs` 覆盖）。
- 等待重试期间出边保持未确定；失败尝试的数据不会进入汇合。
- 第四次失败使整次运行失败：不再启动新步骤，迟到的处理结果与复核提交均无法重新激活节点。

## 目录结构

- `src/types.ts` — 公开类型（工作流定义、处理器、快照、配置）
- `src/workflow.ts` — 工作流解析与校验
- `src/runner.ts` — 运行引擎（调度、汇合、复核、重试）
- `test/branching.test.ts` — 嵌套分流、跨分支共享后继、全部入边排除
- `test/review.test.ts` — 低置信度复核与其他分支重试
- `test/failure.test.ts` — 第四次失败、迟到结果与失败后复核提交

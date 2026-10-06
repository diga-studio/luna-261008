# 进程内工作流推进组件（TypeScript）

一个零运行时依赖的内存工作流引擎：工作流定义与实例状态均保存在内存中，由上层以库的形式调用。

## 要求

- Node.js >= 23.6（利用原生 TypeScript 类型擦除直接运行 `.ts`）
- `npm install` 仅安装开发期类型检查工具（typescript / @types/node），`npm test` 不依赖它们

## 命令

```bash
npm install   # 安装 devDependencies（类型检查用）
npm test      # node --test，运行 tests/ 下全部测试
npm run typecheck
```

## 概念

- 节点类型：`task`（人工任务）、`decision`（二选一决策网关）、`fork`（并行分叉）、`join`（并行汇合）
- 定义必须是合法 DAG、单一入口；只有 `join` 允许多个入口；`decision` 必须紧接一个人工任务，并各有一条 `condition: true/false` 出边
- `fork` 沿全部出边推进；`decision` 依据上游任务提交的布尔结果只走一条出边；任务完成与汇合放行后沿各自出边推进
- 汇合等本次可能到达的入口全部确定后才放行：实际会到达的全部到达，确定不会到达的不再等待；全部入口被排除时汇合不执行，排除结果继续向下游传播
- 每个节点在一个实例中最多激活一次；只接受当前待办任务的结果，重复提交会被拒绝且不会重复推进

## API

```ts
import { WorkflowEngine } from './src/index.ts';

const engine = new WorkflowEngine();

engine.defineWorkflow({
  id: 'approval',
  entry: 'f0',
  nodes: [
    { id: 'f0', kind: 'fork' },
    { id: 'review', kind: 'task' },
    { id: 'audit', kind: 'task' },
    { id: 'd1', kind: 'decision' },
    { id: 'rework', kind: 'task' },
    { id: 'j1', kind: 'join' },
    { id: 'approve', kind: 'task' },
  ],
  edges: [
    { from: 'f0', to: 'review' },
    { from: 'f0', to: 'audit' },
    { from: 'review', to: 'd1' },
    { from: 'd1', to: 'rework', condition: false },
    { from: 'd1', to: 'j1', condition: true },
    { from: 'rework', to: 'j1' },
    { from: 'audit', to: 'j1' },
    { from: 'j1', to: 'approve' },
  ],
});

const instanceId = engine.startInstance('approval');
engine.submitResult(instanceId, 'review', true); // 紧接决策网关的任务必须提交布尔值
engine.submitResult(instanceId, 'audit');
const status = engine.getStatus(instanceId);
// status.state: 'running' | 'completed'
// status.nodes[i].status: 'pending' | 'todo' | 'done' | 'skipped'
```

## 目录

- `src/types.ts`：公开类型定义
- `src/definition.ts`：工作流定义校验（DAG、入口、出入边约束）
- `src/engine.ts`：实例推进、汇合判定、排除传播
- `tests/`：node:test 自动化测试

# workflow-engine

进程内工作流推进库（TypeScript，内存存储）。支持人工任务、二选一决策网关、并行分叉与汇合，条件分支与并行汇合可在同一流程中混用（允许交叉汇合、决策支路绕过汇合）。

## 使用

```bash
npm install
npm test
npm run build
```

```ts
import { WorkflowEngine, WorkflowDefinition } from 'workflow-engine';

const engine = new WorkflowEngine();

const definition: WorkflowDefinition = {
  id: 'approval',
  entry: 'F',
  nodes: [
    { id: 'F', kind: 'fork', outgoing: ['T1', 'T2'] },
    { id: 'T1', kind: 'task', outgoing: ['D1'] },
    { id: 'D1', kind: 'decision', onTrue: 'J', onFalse: 'X' },
    { id: 'X', kind: 'task', outgoing: [] },
    { id: 'T2', kind: 'task', outgoing: ['J'] },
    { id: 'J', kind: 'join', outgoing: ['E'] },
    { id: 'E', kind: 'task', outgoing: [] },
  ],
};

engine.registerDefinition(definition);
const instanceId = engine.startInstance('approval');
engine.submitTaskResult(instanceId, 'T1', true);
const status = engine.getInstanceStatus(instanceId);
// status.todoTasks / completedNodes / excludedNodes / pendingNodes / state
```

## API

- `registerDefinition(def)`：注册并校验定义（DAG、单入口、仅汇合允许多入口、决策必须紧接人工任务）。实例启动后定义不再变化。
- `startInstance(definitionId)`：启动实例，返回实例 id。
- `submitTaskResult(instanceId, taskId, result)`：提交当前待办任务的布尔结果；非待办任务（含重复提交）抛错且不产生任何推进。返回结算后的实例状态。
- `getInstanceStatus(instanceId)`：查询实例状态。

## 语义要点

- 分叉沿全部出边推进；汇合等本次可能到达的入口全部确定（到达或被排除）后放行；全部入口被排除时汇合自身被排除并向下游传播，无需提交虚构结果。
- 决策网关紧接人工任务，依据该任务提交的布尔结果只走一条出边，另一条出边随即死亡并触发下游排除。
- 每个节点在一个实例中最多激活一次；实例在无待办节点时完成。

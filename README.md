# refund-approval

退款审批库（TypeScript），由上层业务直接调用，无接口层，调用者身份由上层确认。

## 功能

- 发布审批定义（同一 id 重复发布版本递增）、发起申请、处理待办、查询状态
- 定义为顺序链，节点支持「全部同意 / 任一同意」两种通过方式
- 申请冻结发起时的定义版本，退回重审也始终按旧版本运行
- 待办操作：同意、加签（仅本轮生效）、退回（当前或任一之前节点）
- 退回使目标及后续节点的旧待办、通过结论、临时加签全部失效，目标节点按原始名单重新产生待办
- 操作标识幂等：相同标识重试返回首次业务结果；旧待办的新操作返回失效
- 历史决定保留可查询，但不参与新一轮计票
- 状态即时持久化到本地 JSON 文件，关闭重开后状态与重试结果保持不变

## 使用

```ts
import { ApprovalEngine } from 'refund-approval';

const engine = new ApprovalEngine('./data/approval.json');

engine.publishDefinition({
  id: 'refund',
  nodes: [
    { key: 'ops', approvers: ['alice', 'bob'], mode: 'ALL' },
    { key: 'finance', approvers: ['carol'], mode: 'ANY' },
  ],
});

const appId = engine.createApplication('refund');
const [todo] = engine.listPendingTodos('alice');
engine.approve(todo.id, 'alice', 'op-001');        // 同意
engine.addSign(todo.id, 'alice', 'op-002', 'dave'); // 加签
engine.sendBack(todo.id, 'alice', 'op-003', 0);     // 退回到节点 0
const view = engine.getApplication(appId);          // 查询状态与全部待办
```

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>=18）与 devDependencies 中的 typescript / @types/node，无需数据库、Docker 或任何常驻服务。

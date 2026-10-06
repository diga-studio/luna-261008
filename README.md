# refund-approval

退款审批库（TypeScript），由上层业务直接调用，无接口层；调用者身份由上层确认后传入。

## 构建与测试

```bash
npm install
npm test
```

## 功能

- **发布审批定义**：`publishDefinition(id, nodes)`，每次发布版本号递增；节点为顺序链，
  每个节点含审批人名单与通过方式（`all` 全部同意 / `any` 任一同意）。
- **发起申请**：`submitApplication(definitionId)`，绑定发起时最新发布版本的快照，
  此后始终按该版本运行；退回重审也不会改用新配置。
- **处理待办**：`approve` / `addsign` / `returnTo`，均要求传入操作标识 `operationId`。
  - 只能处理属于自己的当前有效待办；旧待办、他人待办、已完成申请的待办一律返回失效。
  - 加签把指定用户加入当前节点本轮审批人名单并产生新待办（已在名单中则不重复产生）；
    `all` 的通过条件立即包含新加入者，`any` 不变。
  - 退回可指向当前或任一之前节点：目标及后续节点的旧待办、通过结论、临时加签全部失效，
    目标之前的通过结论保留；目标节点按原始名单重新产生待办。
  - 节点通过时其余未处理待办立即失效；再次进入同一节点产生全新待办，旧待办提交无效。
- **幂等**：相同 `operationId` 重试返回首次业务结果，不再执行；不同标识重复同意同一待办不重复计票。
- **查询**：`getApplication(id)` 返回状态、当前节点、全部待办（含已失效）与历史决定；
  历史决定仅供查询，不参与新一轮通过条件计算。
- **持久化**：状态保存在本地 JSON 文件（原子写入），重新打开后申请状态与操作重试结果保持不变。

## 示例

```ts
import { ApprovalService, Store } from 'refund-approval';

const svc = new ApprovalService(new Store('./data/state.json'));

svc.publishDefinition('refund', [
  { key: 'ops', approvers: ['alice', 'bob'], mode: 'any' },
  { key: 'finance', approvers: ['carol'], mode: 'all' },
]);

const app = svc.submitApplication('refund');
const todo = app.tasks.find((t) => t.status === 'pending' && t.assignee === 'alice')!;
svc.approve('op-001', todo.id, 'alice'); // { ok: true, type: 'approved' }
svc.approve('op-001', todo.id, 'alice'); // 重试：返回首次结果，不重复执行
```

import { Store } from './store';
import { ActionResult, ApplicationView, Definition, NodeSpec } from './types';
export declare class ApprovalService {
    private readonly store;
    constructor(store: Store);
    /** 发布新版本的审批定义，返回发布后的定义 */
    publishDefinition(id: string, nodes: NodeSpec[]): Definition;
    /** 用发起时最新发布的版本发起申请 */
    submitApplication(definitionId: string): ApplicationView;
    approve(operationId: string, taskId: string, userId: string): ActionResult;
    addsign(operationId: string, taskId: string, userId: string, targetUserId: string): ActionResult;
    returnTo(operationId: string, taskId: string, userId: string, targetNodeKey: string): ActionResult;
    getApplication(applicationId: string): ApplicationView;
    private nextId;
    /** 幂等入口：相同操作标识直接返回首次结果 */
    private runOp;
    /** 找到属于该用户的当前有效待办；旧待办/他人待办/已完成申请一律失效 */
    private findValidTask;
    /** 节点本轮审批人名单 = 原始名单 + 本轮加签 */
    private currentApprovers;
    private isNodePassed;
    /** 节点通过：其余待办失效，进入下一节点或完成申请 */
    private passNode;
    /** 进入节点：按原始名单产生本轮待办 */
    private enterNode;
    private newTask;
    private record;
    private toView;
}

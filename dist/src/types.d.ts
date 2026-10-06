/** 节点通过方式：全部同意 / 任一同意 */
export type PassMode = 'all' | 'any';
/** 审批定义中的节点（发布时提交的形状） */
export interface NodeSpec {
    /** 节点名，定义内唯一 */
    key: string;
    /** 原始审批人名单 */
    approvers: string[];
    mode: PassMode;
}
/** 发布后的审批定义（不可变） */
export interface Definition {
    id: string;
    version: number;
    nodes: NodeSpec[];
}
export type ApplicationStatus = 'running' | 'completed';
export type TaskStatus = 'pending' | 'approved' | 'invalid';
/** 待办 */
export interface Task {
    id: string;
    applicationId: string;
    nodeKey: string;
    /** 第几轮进入该节点（从 1 开始），用于区分新旧待办 */
    round: number;
    assignee: string;
    /** 是否由加签产生 */
    addedBySign: boolean;
    status: TaskStatus;
}
/** 历史决定（同意 / 加签 / 退回），仅记录，不参与新一轮计算 */
export interface Decision {
    applicationId: string;
    nodeKey: string;
    round: number;
    actor: string;
    action: 'approve' | 'addsign' | 'return';
    detail: string;
    at: number;
}
export type ActionResult = {
    ok: true;
    type: 'approved';
} | {
    ok: true;
    type: 'signed';
} | {
    ok: true;
    type: 'returned';
} | {
    ok: false;
    reason: string;
};
export interface ApplicationView {
    id: string;
    definitionId: string;
    version: number;
    status: ApplicationStatus;
    currentNodeKey: string | null;
    tasks: Task[];
    decisions: Decision[];
}
/** 内部：申请完整运行状态（持久化用） */
export interface Application {
    id: string;
    definitionId: string;
    version: number;
    /** 发起时绑定的定义快照，此后不变 */
    nodes: NodeSpec[];
    status: ApplicationStatus;
    currentNodeIndex: number;
    /** rounds[i]：节点 i 当前是第几轮进入 */
    rounds: number[];
    /** passed[i]：节点 i 当前是否已通过（退回会清除目标及后续） */
    passed: boolean[];
    /** addsigns[i]：节点 i 本轮临时加签的人 */
    addsigns: string[][];
    tasks: Task[];
    decisions: Decision[];
}

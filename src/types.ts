/** 节点通过方式：全部同意 / 任一同意 */
export type PassMode = 'ALL' | 'ANY';

/** 审批定义中的节点（发布时提交的配置） */
export interface NodeConfig {
  /** 节点标识，定义内唯一 */
  key: string;
  /** 原始审批人名单 */
  approvers: string[];
  /** 通过方式 */
  mode: PassMode;
}

/** 发布审批定义时的输入 */
export interface DefinitionInput {
  /** 定义标识，多次发布同一 id 形成递增版本 */
  id: string;
  nodes: NodeConfig[];
}

/** 已发布的定义（带版本号） */
export interface PublishedDefinition extends DefinitionInput {
  version: number;
}

/** 待办状态 */
export type TodoStatus = 'PENDING' | 'APPROVED' | 'INVALIDATED';

/** 一条待办 */
export interface Todo {
  id: string;
  applicationId: string;
  nodeKey: string;
  nodeIndex: number;
  /** 第几轮进入该节点（从 1 开始） */
  round: number;
  assignee: string;
  status: TodoStatus;
  /** 是否本轮临时加签产生 */
  addedBySign: boolean;
}

/** 申请状态 */
export type ApplicationStatus = 'RUNNING' | 'COMPLETED';

/** 待办操作类型 */
export type ActionType = 'APPROVE' | 'ADD_SIGN' | 'SEND_BACK';

/** 待办操作结果 */
export type ActionResultCode =
  | 'OK'                // 操作生效
  | 'TODO_INVALID'      // 待办不存在或已失效，状态不变
  | 'NOT_ASSIGNEE'      // 不是该待办的审批人
  | 'APP_CLOSED'        // 申请已完成，不再接受动作
  | 'INVALID_TARGET';   // 退回目标非法

export interface ActionResult {
  code: ActionResultCode;
  /** 与首次执行相同操作标识时返回的业务结果一致 */
  replayed: boolean;
}

/** 申请状态查询视图 */
export interface ApplicationView {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: ApplicationStatus;
  currentNodeIndex: number | null;
  currentNodeKey: string | null;
  todos: Todo[];
}

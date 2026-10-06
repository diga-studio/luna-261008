import * as fs from 'fs';
import * as path from 'path';
import { ActionResult, ApplicationStatus, PublishedDefinition, TodoStatus } from './types';

/** 待办记录（含已失效的历史待办） */
export interface TodoRecord {
  id: string;
  applicationId: string;
  nodeIndex: number;
  round: number;
  assignee: string;
  status: TodoStatus;
  /** 是否本轮临时加签产生 */
  addedBySign: boolean;
}

/** 一条历史决定（同意 / 加签 / 退回），仅供查询，不参与新一轮计票 */
export interface DecisionRecord {
  applicationId: string;
  nodeIndex: number;
  round: number;
  userId: string;
  action: 'APPROVE' | 'ADD_SIGN' | 'SEND_BACK';
  /** 加签目标用户或退回目标节点下标 */
  detail: string;
  opId: string;
  seq: number;
}

/** 某节点某一轮的运行状态 */
export interface NodeRoundState {
  nodeIndex: number;
  round: number;
  /** 本轮审批人名单：原始名单 + 本轮临时加签 */
  approvers: string[];
  /** 本轮已同意的审批人 */
  approvedBy: string[];
  /** 本轮是否已通过 */
  passed: boolean;
  /** 本轮是否已因退回而作废 */
  voided: boolean;
}

/** 申请内部状态 */
export interface ApplicationState {
  id: string;
  definitionId: string;
  definitionVersion: number;
  /** 发起时冻结的定义快照，此后始终按它运行 */
  definition: PublishedDefinition;
  status: ApplicationStatus;
  currentNodeIndex: number;
  rounds: NodeRoundState[];
  todos: TodoRecord[];
  decisions: DecisionRecord[];
}

/** 持久化文件的整体结构 */
export interface PersistedData {
  seq: number;
  definitions: PublishedDefinition[];
  applications: ApplicationState[];
  /** 操作标识 -> 首次业务结果（幂等重放） */
  ops: Record<string, ActionResult>;
}

export function emptyData(): PersistedData {
  return { seq: 0, definitions: [], applications: [], ops: {} };
}

/** 基于本地 JSON 文件的持久化存储 */
export class FileStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): PersistedData {
    if (!fs.existsSync(this.filePath)) {
      return emptyData();
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      return emptyData();
    }
    return JSON.parse(raw) as PersistedData;
  }

  save(data: PersistedData): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

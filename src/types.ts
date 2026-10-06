/** 组件手工期望状态 */
export type ExpectedState = 'Not Started' | 'In Progress' | 'Ready' | 'Blocked';

/** 组件实际状态（由期望状态 + 事实推导） */
export type ActualState = ExpectedState;

export type ReleaseStatus = 'Planning' | 'Released';

export type BugSeverity = 'P0' | 'P1' | 'P2' | 'P3';
export type BugStatus = 'Open' | 'In Progress' | 'Resolved' | 'Closed';

export interface BugUpdate {
  bugId: string;
  componentId: string;
  severity?: BugSeverity;
  status?: BugStatus;
}

export interface TestRecordInput {
  componentId: string;
  testId: string;
  /** 完成时间，ISO 字符串或 epoch ms */
  completedAt: string | number;
  passed: number;
  total: number;
  skipped: number;
}

export interface ExpectedStateUpdate {
  componentId: string;
  state: ExpectedState;
}

export interface ChecklistUpdate {
  item: string;
  done: boolean;
}

/** 一个批次：作为一次变化整体生效 */
export interface BatchUpdate {
  bugs?: BugUpdate[];
  tests?: TestRecordInput[];
  expectedStates?: ExpectedStateUpdate[];
  checklist?: ChecklistUpdate[];
}

export interface ComponentGateView {
  componentId: string;
  expected: ExpectedState;
  actual: ActualState;
  p0BlockingBugs: string[];
  latestTest: {
    testId: string;
    completedAt: number;
    passed: number;
    total: number;
    skipped: number;
    passRate: number;
    passing: boolean;
  } | null;
}

export interface GateBasis {
  releaseId: string;
  components: ComponentGateView[];
  checklist: { item: string; done: boolean }[];
}

export interface GatePreview {
  releaseId: string;
  status: ReleaseStatus;
  releasable: boolean;
  blockingReasons: string[];
  basis: GateBasis;
  /** 确认凭据；发布已 Released 时为 null */
  token: ConfirmToken | null;
}

export interface ConfirmToken {
  releaseId: string;
  gateVersion: number;
  nonce: string;
}

export interface ConfirmResult {
  ok: boolean;
  releaseId: string;
  status: ReleaseStatus;
  /** 确认成功时保存的不可变门禁依据 */
  record: (GateBasis & { confirmedAt: number }) | null;
  error?: string;
}

export interface ReleaseInfo {
  releaseId: string;
  status: ReleaseStatus;
  components: string[];
  checklist: { item: string; done: boolean }[];
  gateVersion: number;
}

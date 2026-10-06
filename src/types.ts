/** 组件手工期望状态（由发布经理设置并保存）。 */
export type ExpectedState = "Not Started" | "In Progress" | "Ready" | "Blocked";

/** 组件实际状态（由期望状态、P0 阻塞与最新测试推导）。 */
export type ActualState = ExpectedState;

export type BugSeverity = "P0" | "P1" | "P2" | "P3";
export type BugStatus = "Open" | "In Progress" | "Resolved" | "Closed" | "Reopened";

export type ReleaseStatus = "Planning" | "Released";

export interface ChecklistItemInput {
  itemId: string;
  label?: string;
}

export interface InitReleaseInput {
  releaseId: string;
  name?: string;
  componentIds: string[];
  checklistItems: ChecklistItemInput[];
}

export interface BugUpdate {
  componentId: string;
  bugId: string;
  severity: BugSeverity;
  status: BugStatus;
}

export interface TestRecordInput {
  componentId: string;
  testId: string;
  passed: number;
  total: number;
  skipped?: number;
  /** 完成时间，毫秒时间戳。 */
  completedAt: number;
}

export interface ExpectationUpdate {
  componentId: string;
  expected: ExpectedState;
}

export interface ChecklistUpdate {
  itemId: string;
  done: boolean;
}

/** 一个批次：作为一次变化整体生效。 */
export interface FactBatch {
  bugUpdates?: BugUpdate[];
  tests?: TestRecordInput[];
  expectationUpdates?: ExpectationUpdate[];
  checklistUpdates?: ChecklistUpdate[];
}

export interface TestBasis {
  testId: string;
  passed: number;
  total: number;
  skipped: number;
  completedAt: number;
  passRate: number;
  meetsThreshold: boolean;
}

export interface ComponentGateBasis {
  componentId: string;
  expected: ExpectedState;
  actual: ActualState;
  blockingP0BugIds: string[];
  latestTest: TestBasis | null;
}

export interface ChecklistItemBasis {
  itemId: string;
  label: string | null;
  done: boolean;
}

/** 门禁判断所依据的事实快照。 */
export interface GateBasis {
  components: ComponentGateBasis[];
  checklist: ChecklistItemBasis[];
}

export type GateBlockerReason =
  | "COMPONENT_NOT_READY"
  | "P0_BUG_BLOCKING"
  | "TEST_NOT_QUALIFIED"
  | "CHECKLIST_INCOMPLETE";

export interface GateBlocker {
  reason: GateBlockerReason;
  componentId?: string;
  itemId?: string;
  detail: string;
}

export interface GatePreview {
  releaseId: string;
  status: ReleaseStatus;
  releasable: boolean;
  blockers: GateBlocker[];
  basis: GateBasis;
  /** 确认凭据；自预览起相关事实一旦发生任何变化即失效。 */
  token: string;
}

export interface ConfirmResult {
  ok: boolean;
  releaseId: string;
  status: ReleaseStatus;
  /** 确认成功时保存的不可变门禁依据。 */
  basis?: GateBasis;
  error?: string;
  blockers?: GateBlocker[];
}

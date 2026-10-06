export type StepStatus = 'todo' | 'pending_review' | 'done';

export interface StepSpec {
  id: string;
  text?: string;
}

export interface ProjectSpec {
  projectId: string;
  steps: StepSpec[];
  edges: ReadonlyArray<readonly [string, string]>;
}

export interface StepSnapshot {
  id: string;
  text: string;
  version: number;
  status: StepStatus;
}

export interface ProjectSnapshot {
  projectId: string;
  steps: StepSnapshot[];
}

export interface MutationBase {
  requestKey: string;
  expectedVersion: number;
}

export interface SubmitReviewRequest extends MutationBase {
  stepId: string;
  text?: string;
}

export interface SignOffRequest extends MutationBase {
  stepId: string;
}

export interface ReworkRequest extends MutationBase {
  stepId: string;
}

export type MutationResult =
  | { kind: 'ok'; affected: StepSnapshot[] }
  | { kind: 'version_conflict'; stepId: string; currentVersion: number }
  | { kind: 'precondition_failed'; stepId: string; reason: string }
  | { kind: 'request_key_conflict'; requestKey: string };

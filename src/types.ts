export type StepStatus = 'todo' | 'in_review' | 'completed';

export interface StepDefinition {
  id: string;
  text: string;
}

export interface DependencyEdge {
  /** Predecessor step id. */
  from: string;
  /** Successor step id. */
  to: string;
}

export interface ProjectDefinition {
  projectId: string;
  steps: StepDefinition[];
  dependencies: DependencyEdge[];
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

export type ChangeKind = 'submit' | 'signoff' | 'rework';

export interface SubmitRequest {
  kind: 'submit';
  requestKey: string;
  stepId: string;
  expectedVersion: number;
  /** When provided, replaces the working-paper text. */
  text?: string;
}

export interface SignoffRequest {
  kind: 'signoff';
  requestKey: string;
  stepId: string;
  expectedVersion: number;
}

export interface ReworkRequest {
  kind: 'rework';
  requestKey: string;
  stepId: string;
  expectedVersion: number;
}

export type ChangeRequest = SubmitRequest | SignoffRequest | ReworkRequest;

export interface AffectedStep {
  stepId: string;
  version: number;
  status: StepStatus;
}

export type ChangeResult =
  | { type: 'ok'; kind: ChangeKind; affected: AffectedStep[] }
  | { type: 'version_conflict'; stepId: string; currentVersion: number }
  | { type: 'precondition_failed'; reason: string }
  | { type: 'request_key_conflict'; requestKey: string };

import { Store } from './store.js';
import { DependencyGraph } from './graph.js';
import type {
  ProjectSpec,
  ProjectSnapshot,
  MutationResult,
  SubmitReviewRequest,
  SignOffRequest,
  ReworkRequest,
  StepSnapshot,
} from './types.js';

type OpType = 'submit' | 'signoff' | 'rework';

export class AuditModule {
  private readonly store: Store;
  private readonly graphs = new Map<string, DependencyGraph>();

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  close(): void {
    this.store.close();
  }

  initProject(spec: ProjectSpec): void {
    DependencyGraph.create(
      spec.steps.map((s) => s.id),
      spec.edges,
    );
    if (this.store.projectExists(spec.projectId)) {
      throw new Error(`project already exists: ${spec.projectId}`);
    }
    this.store.createProject(spec);
  }

  submitReview(projectId: string, req: SubmitReviewRequest): MutationResult {
    return this.runMutation(projectId, 'submit', req, req.requestKey, () => {
      const graph = this.graphFor(projectId);
      const step = this.store.getStep(projectId, req.stepId);
      if (!step) {
        return { kind: 'precondition_failed', stepId: req.stepId, reason: 'unknown step' };
      }
      if (step.version !== req.expectedVersion) {
        return { kind: 'version_conflict', stepId: step.id, currentVersion: step.version };
      }
      if (step.status !== 'todo') {
        return {
          kind: 'precondition_failed',
          stepId: step.id,
          reason: `submit requires status todo, got ${step.status}`,
        };
      }
      const blockedBy = this.unfinishedPredecessors(projectId, graph, step.id);
      if (blockedBy.length > 0) {
        return {
          kind: 'precondition_failed',
          stepId: step.id,
          reason: `predecessors not done: ${blockedBy.join(', ')}`,
        };
      }
      const updated: StepSnapshot = {
        id: step.id,
        text: req.text ?? step.text,
        version: step.version + 1,
        status: 'pending_review',
      };
      return this.commit(projectId, [updated]);
    });
  }

  signOff(projectId: string, req: SignOffRequest): MutationResult {
    return this.runMutation(projectId, 'signoff', req, req.requestKey, () => {
      const graph = this.graphFor(projectId);
      const step = this.store.getStep(projectId, req.stepId);
      if (!step) {
        return { kind: 'precondition_failed', stepId: req.stepId, reason: 'unknown step' };
      }
      if (step.version !== req.expectedVersion) {
        return { kind: 'version_conflict', stepId: step.id, currentVersion: step.version };
      }
      if (step.status !== 'pending_review') {
        return {
          kind: 'precondition_failed',
          stepId: step.id,
          reason: `signoff requires status pending_review, got ${step.status}`,
        };
      }
      const blockedBy = this.unfinishedPredecessors(projectId, graph, step.id);
      if (blockedBy.length > 0) {
        return {
          kind: 'precondition_failed',
          stepId: step.id,
          reason: `predecessors not done: ${blockedBy.join(', ')}`,
        };
      }
      const updated: StepSnapshot = {
        id: step.id,
        text: step.text,
        version: step.version + 1,
        status: 'done',
      };
      return this.commit(projectId, [updated]);
    });
  }

  rework(projectId: string, req: ReworkRequest): MutationResult {
    return this.runMutation(projectId, 'rework', req, req.requestKey, () => {
      const graph = this.graphFor(projectId);
      const step = this.store.getStep(projectId, req.stepId);
      if (!step) {
        return { kind: 'precondition_failed', stepId: req.stepId, reason: 'unknown step' };
      }
      if (step.version !== req.expectedVersion) {
        return { kind: 'version_conflict', stepId: step.id, currentVersion: step.version };
      }
      const affectedIds = graph.selfAndSuccessors(step.id).sort();
      const updates: StepSnapshot[] = affectedIds.map((id) => {
        const current = this.store.getStep(projectId, id)!;
        return {
          id: current.id,
          text: current.text,
          version: current.version + 1,
          status: 'todo',
        };
      });
      return this.commit(projectId, updates);
    });
  }

  getSnapshot(projectId: string): ProjectSnapshot {
    this.graphFor(projectId);
    return { projectId, steps: this.store.listSteps(projectId) };
  }

  private graphFor(projectId: string): DependencyGraph {
    const cached = this.graphs.get(projectId);
    if (cached) return cached;
    if (!this.store.projectExists(projectId)) {
      throw new Error(`unknown project: ${projectId}`);
    }
    const graph = this.store.loadGraph(projectId);
    this.graphs.set(projectId, graph);
    return graph;
  }

  private unfinishedPredecessors(
    projectId: string,
    graph: DependencyGraph,
    stepId: string,
  ): string[] {
    const blocked: string[] = [];
    for (const predId of graph.predecessorsOf(stepId)) {
      const pred = this.store.getStep(projectId, predId)!;
      if (pred.status !== 'done') blocked.push(predId);
    }
    return blocked.sort();
  }

  private commit(projectId: string, updates: StepSnapshot[]): MutationResult {
    this.store.applyStepUpdates(projectId, updates);
    return { kind: 'ok', affected: updates };
  }

  private runMutation(
    projectId: string,
    op: OpType,
    payload: object,
    requestKey: string,
    execute: () => MutationResult,
  ): MutationResult {
    const fingerprint = JSON.stringify({ op, payload });
    return this.store.transaction(() => {
      const existing = this.store.findRequest(projectId, requestKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { kind: 'request_key_conflict', requestKey } satisfies MutationResult;
        }
        return JSON.parse(existing.resultJson) as MutationResult;
      }
      const result = execute();
      if (result.kind === 'ok') {
        this.store.saveRequest(projectId, requestKey, fingerprint, JSON.stringify(result));
      }
      return result;
    });
  }
}

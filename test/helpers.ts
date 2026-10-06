import type {
  MutationResult,
  ProjectSnapshot,
  ProjectSpec,
  StepSnapshot,
  StepStatus,
} from '../src/index.js';

export interface RefStep {
  id: string;
  text: string;
  version: number;
  status: StepStatus;
}

export class RefProject {
  readonly steps = new Map<string, RefStep>();
  private readonly preds = new Map<string, string[]>();
  private readonly succs = new Map<string, string[]>();
  private readonly requests = new Map<string, { fingerprint: string; result: MutationResult }>();

  constructor(spec: ProjectSpec) {
    for (const s of spec.steps) {
      this.steps.set(s.id, { id: s.id, text: s.text ?? '', version: 0, status: 'todo' });
      this.preds.set(s.id, []);
      this.succs.set(s.id, []);
    }
    for (const [from, to] of spec.edges) {
      this.preds.get(to)!.push(from);
      this.succs.get(from)!.push(to);
    }
  }

  submit(requestKey: string, stepId: string, expectedVersion: number, text?: string): MutationResult {
    return this.guard(requestKey, { op: 'submit', stepId, expectedVersion, text }, () => {
      const step = this.steps.get(stepId);
      if (!step) return { kind: 'precondition_failed', stepId, reason: 'unknown step' };
      if (step.version !== expectedVersion) {
        return { kind: 'version_conflict', stepId, currentVersion: step.version };
      }
      if (step.status !== 'todo') {
        return { kind: 'precondition_failed', stepId, reason: 'not todo' };
      }
      const blocked = this.preds.get(stepId)!.filter((p) => this.steps.get(p)!.status !== 'done');
      if (blocked.length > 0) {
        return { kind: 'precondition_failed', stepId, reason: 'preds not done' };
      }
      step.text = text ?? step.text;
      step.status = 'pending_review';
      step.version += 1;
      return { kind: 'ok', affected: [this.copy(step)] };
    });
  }

  signoff(requestKey: string, stepId: string, expectedVersion: number): MutationResult {
    return this.guard(requestKey, { op: 'signoff', stepId, expectedVersion }, () => {
      const step = this.steps.get(stepId);
      if (!step) return { kind: 'precondition_failed', stepId, reason: 'unknown step' };
      if (step.version !== expectedVersion) {
        return { kind: 'version_conflict', stepId, currentVersion: step.version };
      }
      if (step.status !== 'pending_review') {
        return { kind: 'precondition_failed', stepId, reason: 'not pending_review' };
      }
      const blocked = this.preds.get(stepId)!.filter((p) => this.steps.get(p)!.status !== 'done');
      if (blocked.length > 0) {
        return { kind: 'precondition_failed', stepId, reason: 'preds not done' };
      }
      step.status = 'done';
      step.version += 1;
      return { kind: 'ok', affected: [this.copy(step)] };
    });
  }

  rework(requestKey: string, stepId: string, expectedVersion: number): MutationResult {
    return this.guard(requestKey, { op: 'rework', stepId, expectedVersion }, () => {
      const step = this.steps.get(stepId);
      if (!step) return { kind: 'precondition_failed', stepId, reason: 'unknown step' };
      if (step.version !== expectedVersion) {
        return { kind: 'version_conflict', stepId, currentVersion: step.version };
      }
      const seen = new Set<string>([stepId]);
      const stack = [stepId];
      while (stack.length > 0) {
        for (const next of this.succs.get(stack.pop()!)!) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      const affected: StepSnapshot[] = [];
      for (const id of [...seen].sort()) {
        const s = this.steps.get(id)!;
        s.status = 'todo';
        s.version += 1;
        affected.push(this.copy(s));
      }
      return { kind: 'ok', affected };
    });
  }

  snapshot(): StepSnapshot[] {
    return [...this.steps.values()].map((s) => this.copy(s)).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  private copy(s: RefStep): StepSnapshot {
    return { id: s.id, text: s.text, version: s.version, status: s.status };
  }

  private guard(requestKey: string, payload: object, execute: () => MutationResult): MutationResult {
    const fingerprint = JSON.stringify(payload);
    const existing = this.requests.get(requestKey);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.result
        : { kind: 'request_key_conflict', requestKey };
    }
    const result = execute();
    if (result.kind === 'ok') this.requests.set(requestKey, { fingerprint, result });
    return result;
  }
}

export function assertSnapshotEquals(actual: ProjectSnapshot, expected: StepSnapshot[]): void {
  const norm = (s: StepSnapshot[]) =>
    s.map((x) => `${x.id}|${x.text}|${x.version}|${x.status}`).sort();
  const a = norm(actual.steps);
  const e = norm(expected);
  if (a.length !== e.length || a.some((v, i) => v !== e[i])) {
    throw new Error(`snapshot mismatch\nactual:   ${a.join(' ')}\nexpected: ${e.join(' ')}`);
  }
}

export function assertDonePredecessorsDone(spec: ProjectSpec, snap: ProjectSnapshot): void {
  const byId = new Map(snap.steps.map((s) => [s.id, s]));
  for (const [from, to] of spec.edges) {
    if (byId.get(to)!.status === 'done' && byId.get(from)!.status !== 'done') {
      throw new Error(`invariant violated: ${to} done but predecessor ${from} is ${byId.get(from)!.status}`);
    }
  }
}

export function diamondSpec(projectId: string): ProjectSpec {
  return {
    projectId,
    steps: [
      { id: 'A', text: 'doc-A' },
      { id: 'B', text: 'doc-B' },
      { id: 'C', text: 'doc-C' },
      { id: 'D', text: 'doc-D' },
      { id: 'E', text: 'doc-E' },
      { id: 'X', text: 'doc-X' },
      { id: 'Y', text: 'doc-Y' },
    ],
    edges: [
      ['A', 'B'], ['A', 'C'],
      ['B', 'D'], ['C', 'D'],
      ['D', 'E'], ['B', 'E'], ['C', 'E'],
      ['X', 'Y'],
    ],
  };
}

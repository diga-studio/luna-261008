import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepEqual } from 'node:assert/strict';
import type { AuditStore } from '../src/store.ts';
import type {
  ChangeRequest,
  ChangeResult,
  DependencyEdge,
  ProjectDefinition,
  StepSnapshot,
  StepStatus,
} from '../src/types.ts';

export function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'audit-store-')), 'test.db');
}

interface ModelStep {
  text: string;
  version: number;
  status: StepStatus;
}

/**
 * Independent in-memory reimplementation of the business rules, used by
 * tests to compute expected snapshots step by step.
 */
export class Model {
  readonly #steps = new Map<string, ModelStep>();
  readonly #edges: DependencyEdge[];

  constructor(def: ProjectDefinition) {
    for (const step of def.steps) {
      this.#steps.set(step.id, { text: step.text, version: 0, status: 'todo' });
    }
    this.#edges = [...def.dependencies];
  }

  apply(req: ChangeRequest): ChangeResult {
    const step = this.#steps.get(req.stepId);
    if (step === undefined) {
      return { type: 'precondition_failed', reason: `unknown step: ${req.stepId}` };
    }
    if (step.version !== req.expectedVersion) {
      return { type: 'version_conflict', stepId: req.stepId, currentVersion: step.version };
    }
    if (req.kind === 'rework') {
      const affected = [];
      for (const id of descendants(this.#edges, req.stepId)) {
        const target = this.#steps.get(id)!;
        target.status = 'todo';
        target.version += 1;
        affected.push({ stepId: id, version: target.version, status: target.status });
      }
      return { type: 'ok', kind: 'rework', affected };
    }
    const required: StepStatus = req.kind === 'submit' ? 'todo' : 'in_review';
    if (step.status !== required) {
      return { type: 'precondition_failed', reason: 'wrong status' };
    }
    const predsDone = this.#edges
      .filter((edge) => edge.to === req.stepId)
      .every((edge) => this.#steps.get(edge.from)!.status === 'completed');
    if (!predsDone) {
      return { type: 'precondition_failed', reason: 'predecessor not completed' };
    }
    if (req.kind === 'submit') {
      step.status = 'in_review';
      step.version += 1;
      if (req.text !== undefined) {
        step.text = req.text;
      }
    } else {
      step.status = 'completed';
      step.version += 1;
    }
    return {
      type: 'ok',
      kind: req.kind,
      affected: [{ stepId: req.stepId, version: step.version, status: step.status }],
    };
  }

  snapshot(): StepSnapshot[] {
    return [...this.#steps.entries()]
      .map(([id, step]) => ({ id, text: step.text, version: step.version, status: step.status }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Deep-copies the model so speculative branches can be explored. */
  fork(): Model {
    const copy = new Model({ projectId: 'fork', steps: [], dependencies: [] });
    for (const [id, step] of this.#steps) {
      copy.#steps.set(id, { ...step });
    }
    copy.#edges.push(...this.#edges);
    return copy;
  }
}

export function descendants(edges: readonly DependencyEdge[], start: string): string[] {
  const reached = new Set<string>([start]);
  const queue = [start];
  const ordered = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.from === current && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
        ordered.push(edge.to);
      }
    }
  }
  return ordered;
}

function normalizeResult(result: ChangeResult): unknown {
  if (result.type === 'ok') {
    const affected = [...result.affected].sort((a, b) => (a.stepId < b.stepId ? -1 : 1));
    return { type: result.type, kind: result.kind, affected };
  }
  if (result.type === 'version_conflict') {
    return { type: result.type, stepId: result.stepId, currentVersion: result.currentVersion };
  }
  if (result.type === 'request_key_conflict') {
    return { type: result.type, requestKey: result.requestKey };
  }
  return { type: result.type };
}

export function resultsEqual(actual: ChangeResult, expected: ChangeResult): boolean {
  try {
    deepEqual(normalizeResult(actual), normalizeResult(expected));
    return true;
  } catch {
    return false;
  }
}

export function assertResultsEqual(actual: ChangeResult, expected: ChangeResult): void {
  if (!resultsEqual(actual, expected)) {
    deepEqual(normalizeResult(actual), normalizeResult(expected));
  }
}

/** Applies the request to both store and model, asserting identical outcomes. */
export async function applyBoth(
  store: AuditStore,
  model: Model,
  projectId: string,
  req: ChangeRequest,
): Promise<ChangeResult> {
  const expected = model.apply(req);
  const actual =
    req.kind === 'submit'
      ? await store.submit(projectId, req)
      : req.kind === 'signoff'
        ? await store.signoff(projectId, req)
        : await store.rework(projectId, req);
  assertResultsEqual(actual, expected);
  return actual;
}

/** Asserts the stored snapshot equals the model and satisfies the sign-off invariant. */
export async function expectConsistent(
  store: AuditStore,
  model: Model,
  projectId: string,
  edges: readonly DependencyEdge[],
): Promise<StepSnapshot[]> {
  const snapshot = await store.getSnapshot(projectId);
  deepEqual(snapshot.steps, model.snapshot());
  const byId = new Map(snapshot.steps.map((step) => [step.id, step]));
  const predsByStep = new Map<string, string[]>();
  for (const edge of edges) {
    const list = predsByStep.get(edge.to);
    if (list === undefined) {
      predsByStep.set(edge.to, [edge.from]);
    } else {
      list.push(edge.from);
    }
  }
  for (const step of snapshot.steps) {
    if (step.status !== 'completed') {
      continue;
    }
    for (const predId of predsByStep.get(step.id) ?? []) {
      const pred = byId.get(predId)!;
      if (pred.status !== 'completed') {
        throw new Error(`invariant violated: ${step.id} completed but predecessor ${predId} is ${pred.status}`);
      }
    }
  }
  return snapshot.steps;
}

let keyCounter = 0;
export function uniqueKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}`;
}

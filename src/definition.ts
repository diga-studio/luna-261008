import type { ProcessDefinition } from "./types.js";

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** 校验工序定义并返回拓扑序（定义保证无环，此处仍做防御性校验） */
export function validateDefinition(def: ProcessDefinition): string[] {
  if (!def || !Array.isArray(def.steps)) {
    throw new Error("definition must contain a steps array");
  }

  const ids = new Set<string>();
  for (const step of def.steps) {
    if (!step || typeof step.id !== "string" || step.id.length === 0) {
      throw new Error("every step must have a non-empty string id");
    }
    if (ids.has(step.id)) {
      throw new Error(`duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of def.steps) {
    if (step.kind !== "manual" && step.kind !== "wait") {
      throw new Error(`step ${step.id}: kind must be "manual" or "wait"`);
    }
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`step ${step.id}: unknown dependency ${dep}`);
      }
      if (dep === step.id) {
        throw new Error(`step ${step.id}: cannot depend on itself`);
      }
    }
    if (step.kind === "wait") {
      if (step.durationMs === undefined || !isPositiveInteger(step.durationMs)) {
        throw new Error(`wait step ${step.id}: durationMs must be a positive integer`);
      }
      const reminders = step.reminders ?? [];
      if (reminders.length > 3) {
        throw new Error(`wait step ${step.id}: at most 3 reminders allowed`);
      }
      for (const offset of reminders) {
        if (!isPositiveInteger(offset) || offset >= step.durationMs) {
          throw new Error(
            `wait step ${step.id}: reminder offset must be a positive integer smaller than durationMs`,
          );
        }
      }
    }
  }

  // Kahn 拓扑排序；定义保证无环，发现环说明输入非法。
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const step of def.steps) {
    for (const dep of step.dependsOn ?? []) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependents.get(dep)!.push(step.id);
    }
  }
  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const degree = indegree.get(next)! - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (order.length !== ids.size) {
    throw new Error("definition contains a dependency cycle");
  }
  return order;
}

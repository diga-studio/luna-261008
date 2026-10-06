import type { ProcessDefinition } from './types.js';

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** 校验工序定义，非法时抛出 Error。合法定义保证：编号唯一、依赖存在、无环、等待参数合法。 */
export function validateDefinition(def: ProcessDefinition): void {
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (!step.id) {
      throw new Error('step id must be non-empty');
    }
    if (ids.has(step.id)) {
      throw new Error(`duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
    if (step.kind === 'wait') {
      if (step.durationMs === undefined || !isPositiveInteger(step.durationMs)) {
        throw new Error(`wait step ${step.id} requires a positive integer durationMs`);
      }
      const reminders = step.reminders ?? [];
      if (reminders.length > 3) {
        throw new Error(`wait step ${step.id} has more than 3 reminders`);
      }
      for (const offset of reminders) {
        if (!isPositiveInteger(offset) || offset >= step.durationMs) {
          throw new Error(
            `reminder offset ${offset} of step ${step.id} must be a positive integer less than durationMs`,
          );
        }
      }
    }
  }

  const successors = new Map<string, string[]>();
  for (const dep of def.dependencies) {
    if (!ids.has(dep.from) || !ids.has(dep.to)) {
      throw new Error(`dependency references unknown step: ${dep.from} -> ${dep.to}`);
    }
    if (dep.from === dep.to) {
      throw new Error(`self dependency on step: ${dep.from}`);
    }
    const list = successors.get(dep.from) ?? [];
    list.push(dep.to);
    successors.set(dep.from, list);
  }

  // 拓扑排序验证无环（Kahn 算法）
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const dep of def.dependencies) {
    indegree.set(dep.to, (indegree.get(dep.to) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop() as string;
    visited += 1;
    for (const next of successors.get(id) ?? []) {
      const deg = (indegree.get(next) as number) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (visited !== ids.size) {
    throw new Error('process definition contains a dependency cycle');
  }
}

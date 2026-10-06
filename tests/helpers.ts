import type { InstanceStatus, NodeStatus, WorkflowDefinition } from '../src/index.ts';

export function statusMap(status: InstanceStatus): Map<string, NodeStatus> {
  return new Map(status.nodes.map((n) => [n.id, n.status]));
}

export function executedSet(status: InstanceStatus): Set<string> {
  return new Set(status.nodes.filter((n) => n.status === 'done').map((n) => n.id));
}

export function skippedSet(status: InstanceStatus): Set<string> {
  return new Set(status.nodes.filter((n) => n.status === 'skipped').map((n) => n.id));
}

/**
 * 按已提交的布尔结果选路后，从入口推导出的可达节点集合。
 * 决策网关的出边按其上游人工任务提交的结果选择。
 */
export function reachableSet(
  def: WorkflowDefinition,
  results: ReadonlyMap<string, boolean>,
): Set<string> {
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
  const decisionSourceTask = new Map<string, string>();
  for (const edge of def.edges) {
    if (nodeById.get(edge.to)?.kind === 'decision') {
      decisionSourceTask.set(edge.to, edge.from);
    }
  }
  const taken = new Set<string>([def.entry]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of def.edges) {
      if (!taken.has(edge.from) || taken.has(edge.to)) continue;
      const source = nodeById.get(edge.from)!;
      if (source.kind === 'decision') {
        const taskId = decisionSourceTask.get(edge.from)!;
        if (results.get(taskId) !== edge.condition) continue;
      }
      taken.add(edge.to);
      changed = true;
    }
  }
  return taken;
}

import type { WorkflowDefinition } from './types.ts';

export class DefinitionError extends Error {}

/** 校验工作流定义：合法 DAG、唯一入口、各类节点的出入边约束。不合法时抛错。 */
export function validateDefinition(def: WorkflowDefinition): void {
  if (!def || typeof def.id !== 'string' || def.id.length === 0) {
    throw new DefinitionError('definition id is required');
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    throw new DefinitionError('definition must contain at least one node');
  }

  const nodes = new Map<string, WorkflowDefinition['nodes'][number]>();
  for (const node of def.nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      throw new DefinitionError('every node needs a non-empty id');
    }
    if (nodes.has(node.id)) {
      throw new DefinitionError(`duplicate node id: ${node.id}`);
    }
    if (!['task', 'decision', 'fork', 'join'].includes(node.kind)) {
      throw new DefinitionError(`node ${node.id} has unknown kind: ${node.kind}`);
    }
    nodes.set(node.id, node);
  }

  const entry = nodes.get(def.entry);
  if (!entry) {
    throw new DefinitionError(`entry node not found: ${def.entry}`);
  }

  const outgoing = new Map<string, WorkflowDefinition['edges'][number][]>();
  const incoming = new Map<string, WorkflowDefinition['edges'][number][]>();
  const seenEdges = new Set<string>();
  for (const edge of def.edges ?? []) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new DefinitionError(`edge references unknown node: ${edge.from} -> ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new DefinitionError(`self edge is not allowed: ${edge.from}`);
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) {
      throw new DefinitionError(`duplicate edge: ${key}`);
    }
    seenEdges.add(key);
    const fromKind = nodes.get(edge.from)!.kind;
    if (edge.condition !== undefined && fromKind !== 'decision') {
      throw new DefinitionError(`condition only allowed on decision out-edges: ${key}`);
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  const outOf = (id: string) => outgoing.get(id) ?? [];
  const inOf = (id: string) => incoming.get(id) ?? [];

  if (inOf(entry.id).length !== 0) {
    throw new DefinitionError(`entry node must have no incoming edges: ${entry.id}`);
  }

  for (const node of nodes.values()) {
    const ins = inOf(node.id);
    const outs = outOf(node.id);
    if (node.id !== entry.id && ins.length === 0) {
      throw new DefinitionError(`node is unreachable from entry (no incoming edges): ${node.id}`);
    }
    if (node.kind !== 'join' && ins.length > 1) {
      throw new DefinitionError(`only join may have multiple incoming edges: ${node.id}`);
    }
    switch (node.kind) {
      case 'task':
        if (outs.length > 1) {
          throw new DefinitionError(`task may have at most one outgoing edge: ${node.id}`);
        }
        break;
      case 'decision': {
        if (ins.length !== 1) {
          throw new DefinitionError(`decision needs exactly one incoming edge: ${node.id}`);
        }
        if (nodes.get(ins[0].from)!.kind !== 'task') {
          throw new DefinitionError(`decision must directly follow a task: ${node.id}`);
        }
        const trues = outs.filter((e) => e.condition === true);
        const falses = outs.filter((e) => e.condition === false);
        if (outs.length !== 2 || trues.length !== 1 || falses.length !== 1) {
          throw new DefinitionError(
            `decision needs exactly one true and one false out-edge: ${node.id}`,
          );
        }
        break;
      }
      case 'fork':
        if (outs.length === 0) {
          throw new DefinitionError(`fork needs at least one outgoing edge: ${node.id}`);
        }
        break;
      case 'join':
        if (ins.length === 0) {
          throw new DefinitionError(`join needs at least one incoming edge: ${node.id}`);
        }
        if (outs.length > 1) {
          throw new DefinitionError(`join may have at most one outgoing edge: ${node.id}`);
        }
        break;
    }
  }

  // DAG 校验：拓扑排序，若存在环则排序后仍有剩余节点。
  const indegree = new Map<string, number>();
  for (const node of nodes.values()) indegree.set(node.id, inOf(node.id).length);
  const queue = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    visited += 1;
    for (const edge of outOf(id)) {
      const next = indegree.get(edge.to)! - 1;
      indegree.set(edge.to, next);
      if (next === 0) queue.push(edge.to);
    }
  }
  if (visited !== nodes.size) {
    throw new DefinitionError('definition must be a DAG (cycle detected)');
  }
}

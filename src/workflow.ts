import type { WorkflowDef } from "./types.js";

/** 解析并校验工作流定义，返回便于运行的内部结构 */
export interface CompiledWorkflow {
  def: WorkflowDef;
  nodeIds: string[];
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

export function compileWorkflow(def: WorkflowDef): CompiledWorkflow {
  if (!def || !Array.isArray(def.nodes) || def.nodes.length === 0) {
    throw new Error("workflow must contain at least one node");
  }
  const nodeIds = new Set<string>();
  for (const node of def.nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    if (node.kind !== "process" && node.kind !== "condition") {
      throw new Error(`node ${node.id} has invalid kind: ${String(node.kind)}`);
    }
    nodeIds.add(node.id);
  }
  if (!nodeIds.has(def.entry)) {
    throw new Error(`entry node not found: ${def.entry}`);
  }
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  const seenEdges = new Set<string>();
  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`edge references unknown node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`edge references unknown node: ${edge.to}`);
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) {
      throw new Error(`duplicate edge: ${key}`);
    }
    seenEdges.add(key);
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
  }
  if (incoming.get(def.entry)!.length > 0) {
    throw new Error(`entry node must not have incoming edges: ${def.entry}`);
  }
  return {
    def,
    nodeIds: [...nodeIds],
    outgoing,
    incoming,
  };
}

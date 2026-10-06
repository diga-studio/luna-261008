import type { DependencyEdge } from './types.ts';

/** Validates the dependency graph: known endpoints, no duplicate steps/edges, acyclic. Throws on invalid input. */
export function validateGraph(stepIds: readonly string[], edges: readonly DependencyEdge[]): void {
  const ids = new Set<string>();
  for (const id of stepIds) {
    if (ids.has(id)) {
      throw new Error(`duplicate step id: ${id}`);
    }
    ids.add(id);
  }
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.from)) {
      throw new Error(`dependency references unknown step: ${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      throw new Error(`dependency references unknown step: ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new Error(`self dependency on step: ${edge.from}`);
    }
    const key = `${edge.from}→${edge.to}`;
    if (seenEdges.has(key)) {
      throw new Error(`duplicate dependency: ${edge.from} -> ${edge.to}`);
    }
    seenEdges.add(key);
  }
  // Iterative DFS cycle detection (white/gray/black).
  const adjacency = buildAdjacency(edges);
  const white = 0;
  const gray = 1;
  const black = 2;
  const color = new Map<string, number>();
  for (const id of stepIds) {
    color.set(id, white);
  }
  for (const root of stepIds) {
    if (color.get(root) !== white) {
      continue;
    }
    const stack: { id: string; childIndex: number }[] = [{ id: root, childIndex: 0 }];
    color.set(root, gray);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adjacency.get(frame.id) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex]!;
        frame.childIndex += 1;
        const childColor = color.get(child);
        if (childColor === gray) {
          throw new Error(`dependency graph has a cycle involving step: ${child}`);
        }
        if (childColor === white) {
          color.set(child, gray);
          stack.push({ id: child, childIndex: 0 });
        }
      } else {
        color.set(frame.id, black);
        stack.pop();
      }
    }
  }
}

function buildAdjacency(edges: readonly DependencyEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    let list = adjacency.get(edge.from);
    if (list === undefined) {
      list = [];
      adjacency.set(edge.from, list);
    }
    list.push(edge.to);
  }
  return adjacency;
}

/** Returns the step itself plus all direct and indirect successors. */
export function selfAndDescendants(edges: readonly DependencyEdge[], start: string): Set<string> {
  const adjacency = buildAdjacency(edges);
  const reached = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        stack.push(next);
      }
    }
  }
  return reached;
}

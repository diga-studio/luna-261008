export class DependencyGraph {
  private constructor(
    private readonly stepIds: ReadonlySet<string>,
    private readonly predecessors: ReadonlyMap<string, readonly string[]>,
    private readonly successors: ReadonlyMap<string, readonly string[]>,
  ) {}

  static create(
    stepIds: readonly string[],
    edges: ReadonlyArray<readonly [string, string]>,
  ): DependencyGraph {
    const idSet = new Set(stepIds);
    if (idSet.size !== stepIds.length) {
      throw new Error('duplicate step id');
    }
    const preds = new Map<string, string[]>();
    const succs = new Map<string, string[]>();
    for (const id of stepIds) {
      preds.set(id, []);
      succs.set(id, []);
    }
    const seenEdges = new Set<string>();
    for (const [from, to] of edges) {
      if (!idSet.has(from) || !idSet.has(to)) {
        throw new Error(`edge references unknown step: ${from} -> ${to}`);
      }
      if (from === to) {
        throw new Error(`self edge on step: ${from}`);
      }
      const key = `${from}→${to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      preds.get(to)!.push(from);
      succs.get(from)!.push(to);
    }
    const graph = new DependencyGraph(idSet, preds, succs);
    graph.assertAcyclic();
    return graph;
  }

  private assertAcyclic(): void {
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (id: string): void => {
      const s = state.get(id) ?? 0;
      if (s === 1) throw new Error('dependency graph contains a cycle');
      if (s === 2) return;
      state.set(id, 1);
      for (const next of this.successors.get(id)!) visit(next);
      state.set(id, 2);
    };
    for (const id of this.stepIds) visit(id);
  }

  has(stepId: string): boolean {
    return this.stepIds.has(stepId);
  }

  predecessorsOf(stepId: string): readonly string[] {
    const preds = this.predecessors.get(stepId);
    if (!preds) throw new Error(`unknown step: ${stepId}`);
    return preds;
  }

  selfAndSuccessors(stepId: string): string[] {
    if (!this.stepIds.has(stepId)) throw new Error(`unknown step: ${stepId}`);
    const seen = new Set<string>([stepId]);
    const order: string[] = [];
    const stack = [stepId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      order.push(current);
      for (const next of this.successors.get(current)!) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return order;
  }
}

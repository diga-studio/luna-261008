interface UserEdge {
  from: number;
  to: number;
  lower: number;
  upper: number;
  cost: number;
}

interface ResidualEdge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

/**
 * Min-cost circulation with lower bounds on a small directed graph.
 * Nodes are numbered 0..nodeCount-1. Capacities and costs are integers.
 */
export class MinCostCirculation {
  private readonly nodeCount: number;
  private readonly userEdges: UserEdge[] = [];

  constructor(nodeCount: number) {
    this.nodeCount = nodeCount;
  }

  /**
   * Add a directed edge with integer lower/upper capacity and integer cost.
   * Returns the edge index, used to read the flow from the solution.
   */
  addEdge(from: number, to: number, lower: number, upper: number, cost: number): number {
    if (lower < 0 || upper < lower) {
      throw new Error(`invalid capacity bounds [${lower}, ${upper}]`);
    }
    this.userEdges.push({ from, to, lower, upper, cost });
    return this.userEdges.length - 1;
  }

  /**
   * Find a feasible min-cost circulation honoring all lower/upper bounds.
   * Returns null when no feasible circulation exists. On success, `flows`
   * holds the flow of each edge in addEdge order and `cost` is the total
   * cost of the circulation.
   */
  solve(): { cost: number; flows: number[] } | null {
    const superSource = this.nodeCount;
    const superSink = this.nodeCount + 1;
    const graph: ResidualEdge[][] = Array.from(
      { length: this.nodeCount + 2 },
      () => [],
    );
    const addResidual = (from: number, to: number, cap: number, cost: number): void => {
      graph[from].push({ to, rev: graph[to].length, cap, cost });
      graph[to].push({ to: from, rev: graph[from].length - 1, cap: 0, cost: -cost });
    };

    // Lower-bound transformation: an edge u->v with lower l contributes
    // l units of demand to v and l units of supply to u.
    const balance = new Array<number>(this.nodeCount).fill(0);
    const edgePositions: Array<{ node: number; index: number; cap: number }> = [];
    for (const edge of this.userEdges) {
      balance[edge.from] -= edge.lower;
      balance[edge.to] += edge.lower;
      edgePositions.push({
        node: edge.from,
        index: graph[edge.from].length,
        cap: edge.upper - edge.lower,
      });
      addResidual(edge.from, edge.to, edge.upper - edge.lower, edge.cost);
    }

    let totalDemand = 0;
    for (let node = 0; node < this.nodeCount; node++) {
      if (balance[node] > 0) {
        addResidual(superSource, node, balance[node], 0);
        totalDemand += balance[node];
      } else if (balance[node] < 0) {
        addResidual(node, superSink, -balance[node], 0);
      }
    }

    // Phase 1: feasibility via Edmonds-Karp max flow.
    let sent = 0;
    for (;;) {
      const parent = new Array<number>(graph.length).fill(-1);
      const parentEdge = new Array<number>(graph.length).fill(-1);
      const queue: number[] = [superSource];
      parent[superSource] = superSource;
      for (let head = 0; head < queue.length; head++) {
        const node = queue[head];
        for (let i = 0; i < graph[node].length; i++) {
          const edge = graph[node][i];
          if (edge.cap > 0 && parent[edge.to] === -1) {
            parent[edge.to] = node;
            parentEdge[edge.to] = i;
            queue.push(edge.to);
          }
        }
      }
      if (parent[superSink] === -1) {
        break;
      }
      let delta = Infinity;
      for (let node = superSink; node !== superSource; node = parent[node]) {
        delta = Math.min(delta, graph[parent[node]][parentEdge[node]].cap);
      }
      for (let node = superSink; node !== superSource; node = parent[node]) {
        const edge = graph[parent[node]][parentEdge[node]];
        edge.cap -= delta;
        graph[node][edge.rev].cap += delta;
      }
      sent += delta;
    }
    if (sent < totalDemand) {
      return null;
    }

    // Phase 2: cancel negative-cost cycles until the circulation is optimal.
    for (;;) {
      const dist = new Array<number>(graph.length).fill(0);
      const parent = new Array<number>(graph.length).fill(-1);
      const parentEdge = new Array<number>(graph.length).fill(-1);
      let changed = -1;
      for (let iter = 0; iter < graph.length; iter++) {
        changed = -1;
        for (let node = 0; node < graph.length; node++) {
          for (let i = 0; i < graph[node].length; i++) {
            const edge = graph[node][i];
            if (edge.cap > 0 && dist[edge.to] > dist[node] + edge.cost) {
              dist[edge.to] = dist[node] + edge.cost;
              parent[edge.to] = node;
              parentEdge[edge.to] = i;
              changed = edge.to;
            }
          }
        }
        if (changed === -1) {
          break;
        }
      }
      if (changed === -1) {
        break;
      }
      // Walk far enough back to land inside the negative cycle.
      let node = changed;
      for (let i = 0; i < graph.length; i++) {
        node = parent[node];
      }
      const cycleStart = node;
      let delta = Infinity;
      let cur = cycleStart;
      do {
        delta = Math.min(delta, graph[parent[cur]][parentEdge[cur]].cap);
        cur = parent[cur];
      } while (cur !== cycleStart);
      cur = cycleStart;
      do {
        const edge = graph[parent[cur]][parentEdge[cur]];
        edge.cap -= delta;
        graph[cur][edge.rev].cap += delta;
        cur = parent[cur];
      } while (cur !== cycleStart);
    }

    const flows = new Array<number>(this.userEdges.length);
    let cost = 0;
    for (let i = 0; i < this.userEdges.length; i++) {
      const position = edgePositions[i];
      const used = position.cap - graph[position.node][position.index].cap;
      flows[i] = this.userEdges[i].lower + used;
      cost += flows[i] * this.userEdges[i].cost;
    }
    return { cost, flows };
  }
}

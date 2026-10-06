/**
 * Small generic min-cost flow solver with node balances (supplies/demands).
 * All capacities, balances and costs are integers; the optimal flow is
 * integral. Used to solve the rounding-assignment problem exactly.
 *
 * Solved by successive shortest paths: one SPFA to compute initial
 * potentials (edge costs may be negative), then Dijkstra with reduced
 * costs per augmentation.
 */
export class MinCostFlow {
  private readonly edges: Array<{ from: number; to: number; cap: number; cost: number }> = [];
  private readonly balances = new Map<number, number>();

  /** Add a directed edge with integer capacity and integer cost per unit. */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    if (capacity < 0) {
      throw new Error("capacity must be non-negative");
    }
    this.edges.push({ from, to, cap: capacity, cost });
    return this.edges.length - 1;
  }

  /** Set node balance: positive = must send out, negative = must receive. */
  setBalance(node: number, balance: number): void {
    this.balances.set(node, (this.balances.get(node) ?? 0) + balance);
  }

  /**
   * Solve. Returns null when no feasible flow satisfies all balances,
   * otherwise the flow value on each edge in addEdge order.
   */
  solve(): number[] | null {
    const superSource = this.nextNodeId();
    const superSink = superSource + 1;
    const nodeCount = superSink + 1;

    // Residual graph: forward edges carry original indices, backward edges -1.
    const graph: Array<Array<{ to: number; rev: number; cap: number; cost: number; orig: number }>> =
      Array.from({ length: nodeCount }, () => []);
    const addResidual = (from: number, to: number, cap: number, cost: number, orig: number) => {
      graph[from].push({ to, rev: graph[to].length, cap, cost, orig });
      graph[to].push({ to: from, rev: graph[from].length - 1, cap: 0, cost: -cost, orig: -1 });
    };
    this.edges.forEach((edge, index) => addResidual(edge.from, edge.to, edge.cap, edge.cost, index));

    let required = 0;
    for (const [node, balance] of this.balances) {
      if (balance > 0) {
        addResidual(superSource, node, balance, 0, -1);
        required += balance;
      } else if (balance < 0) {
        addResidual(node, superSink, -balance, 0, -1);
      }
    }

    // Initial potentials via SPFA so reduced costs are non-negative.
    const potential = new Array<number>(nodeCount).fill(0);
    if (required > 0) {
      const dist = new Array<number>(nodeCount).fill(Infinity);
      const inQueue = new Array<boolean>(nodeCount).fill(false);
      dist[superSource] = 0;
      const queue: number[] = [superSource];
      inQueue[superSource] = true;
      while (queue.length > 0) {
        const u = queue.shift() as number;
        inQueue[u] = false;
        for (const edge of graph[u]) {
          if (edge.cap > 0 && dist[u] + edge.cost < dist[edge.to]) {
            dist[edge.to] = dist[u] + edge.cost;
            if (!inQueue[edge.to]) {
              queue.push(edge.to);
              inQueue[edge.to] = true;
            }
          }
        }
      }
      for (let node = 0; node < nodeCount; node++) {
        if (dist[node] < Infinity) {
          potential[node] = dist[node];
        }
      }
    }

    // Successive shortest augmenting paths.
    let sent = 0;
    while (sent < required) {
      const dist = new Array<number>(nodeCount).fill(Infinity);
      const prevNode = new Array<number>(nodeCount).fill(-1);
      const prevEdge = new Array<number>(nodeCount).fill(-1);
      dist[superSource] = 0;
      // Simple binary heap of [distance, node].
      const heap: Array<[number, number]> = [[0, superSource]];
      const push = (item: [number, number]) => {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heap[parent][0] <= heap[i][0]) break;
          [heap[parent], heap[i]] = [heap[i], heap[parent]];
          i = parent;
        }
      };
      const pop = (): [number, number] | undefined => {
        if (heap.length === 0) return undefined;
        const top = heap[0];
        const last = heap.pop() as [number, number];
        if (heap.length > 0) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
            if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
            if (smallest === i) break;
            [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
            i = smallest;
          }
        }
        return top;
      };

      while (heap.length > 0) {
        const [d, u] = pop() as [number, number];
        if (d > dist[u]) continue;
        for (let i = 0; i < graph[u].length; i++) {
          const edge = graph[u][i];
          if (edge.cap <= 0) continue;
          const reduced = edge.cost + potential[u] - potential[edge.to];
          if (dist[u] + reduced < dist[edge.to]) {
            dist[edge.to] = dist[u] + reduced;
            prevNode[edge.to] = u;
            prevEdge[edge.to] = i;
            push([dist[edge.to], edge.to]);
          }
        }
      }

      if (dist[superSink] === Infinity) {
        return null; // balances cannot be satisfied
      }
      for (let node = 0; node < nodeCount; node++) {
        if (dist[node] < Infinity) {
          potential[node] += dist[node];
        }
      }

      let bottleneck = required - sent;
      for (let v = superSink; v !== superSource; v = prevNode[v]) {
        bottleneck = Math.min(bottleneck, graph[prevNode[v]][prevEdge[v]].cap);
      }
      for (let v = superSink; v !== superSource; v = prevNode[v]) {
        const edge = graph[prevNode[v]][prevEdge[v]];
        edge.cap -= bottleneck;
        graph[v][edge.rev].cap += bottleneck;
      }
      sent += bottleneck;
    }

    return this.edges.map((edge, index) => {
      const forward = graph[edge.from].find((candidate) => candidate.orig === index);
      return edge.cap - (forward ? forward.cap : 0);
    });
  }

  private nextNodeId(): number {
    let max = -1;
    for (const edge of this.edges) {
      max = Math.max(max, edge.from, edge.to);
    }
    for (const node of this.balances.keys()) {
      max = Math.max(max, node);
    }
    return max + 1;
  }
}

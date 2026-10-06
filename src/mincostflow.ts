interface Edge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

class BinaryHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const topKey = this.keys[0];
    const topValue = this.values[0];
    const lastKey = this.keys.pop() as number;
    const lastValue = this.values.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return [topKey, topValue];
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = v;
  }
}

/**
 * 最小费用流（SSP + Johnson 势，支持负费用边）。
 * 流量与容量用 number（均 <= 1e12 < 2^53，整数精确）；
 * 总费用用 BigInt 累加，避免超出安全整数范围时产生舍入误差。
 */
export class MinCostFlow {
  private readonly graph: Edge[][];

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  /** 返回正向边在 from 邻接表中的下标，供 flowOn 查询。 */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const forward: Edge = { to, rev: this.graph[to].length, cap: capacity, cost };
    const backward: Edge = { to: from, rev: this.graph[from].length, cap: 0, cost: -cost };
    this.graph[from].push(forward);
    this.graph[to].push(backward);
    return this.graph[from].length - 1;
  }

  /** 正向边上的当前流量（edgeIndex 为 addEdge 的返回值）。 */
  flowOn(source: number, edgeIndex: number): number {
    const edge = this.graph[source][edgeIndex];
    return this.graph[edge.to][edge.rev].cap;
  }

  /**
   * 从 source 向 sink 推送至多 maxFlow 单位流量，费用最小。
   * 返回实际流量与精确总费用（BigInt）。
   */
  solve(source: number, sink: number, maxFlow: number): { flow: number; cost: bigint } {
    const n = this.graph.length;
    const potential = this.bellmanFord(source);

    const dist = new Array<number>(n);
    const prevNode = new Array<number>(n);
    const prevEdge = new Array<number>(n);

    let flow = 0;
    let cost = 0n;

    while (flow < maxFlow) {
      dist.fill(Infinity);
      dist[source] = 0;
      const heap = new BinaryHeap();
      heap.push(0, source);

      while (heap.size > 0) {
        const [d, v] = heap.pop();
        if (d > dist[v]) continue;
        const edges = this.graph[v];
        for (let i = 0; i < edges.length; i += 1) {
          const edge = edges[i];
          if (edge.cap <= 0) continue;
          const nd = d + edge.cost + potential[v] - potential[edge.to];
          if (nd < dist[edge.to]) {
            dist[edge.to] = nd;
            prevNode[edge.to] = v;
            prevEdge[edge.to] = i;
            heap.push(nd, edge.to);
          }
        }
      }

      if (!Number.isFinite(dist[sink])) break;

      for (let v = 0; v < n; v += 1) {
        if (Number.isFinite(dist[v])) potential[v] += dist[v];
      }

      let add = maxFlow - flow;
      for (let v = sink; v !== source; v = prevNode[v]) {
        const edge = this.graph[prevNode[v]][prevEdge[v]];
        if (edge.cap < add) add = edge.cap;
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const edge = this.graph[prevNode[v]][prevEdge[v]];
        edge.cap -= add;
        this.graph[edge.to][edge.rev].cap += add;
      }
      flow += add;
      cost += BigInt(add) * BigInt(potential[sink] - potential[source]);
    }

    return { flow, cost };
  }

  private bellmanFord(source: number): number[] {
    const n = this.graph.length;
    const dist = new Array<number>(n).fill(Infinity);
    dist[source] = 0;
    for (let iter = 0; iter < n - 1; iter += 1) {
      let changed = false;
      for (let v = 0; v < n; v += 1) {
        if (!Number.isFinite(dist[v])) continue;
        for (const edge of this.graph[v]) {
          if (edge.cap <= 0) continue;
          const nd = dist[v] + edge.cost;
          if (nd < dist[edge.to]) {
            dist[edge.to] = nd;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (let v = 0; v < n; v += 1) {
      if (!Number.isFinite(dist[v])) dist[v] = 0;
    }
    return dist;
  }
}

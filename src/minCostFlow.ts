/**
 * 最小费用最大流（SSP + Johnson 势能 + Dijkstra），
 * 用于求解“素材 -> 组合”的运输问题。
 *
 * 流量与费用使用 number（本题规模下单条边流量 <= 1e12、
 * 单条路径费用绝对值 <= 1e6 * 常数，均在安全整数范围内）；
 * 总收益在调用侧用 bigint 精确累加。
 */

export interface FlowEdgeInput {
  from: number;
  to: number;
  capacity: number;
  cost: number;
}

export interface MinCostFlowResult {
  /** 实际送出的总流量；小于需求量即不可行。 */
  totalFlow: number;
  /** 每条输入边（按加入顺序）上的最终流量。 */
  edgeFlows: number[];
}

export class MinCostFlowSolver {
  private readonly nodeCount: number;
  private readonly head: number[];
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly cost: number[] = [];
  private readonly next: number[] = [];
  /** 每条输入边对应的正向边下标（按 addEdge 顺序）。 */
  private readonly forwardEdgeIndex: number[] = [];
  private readonly forwardEdgeCapacity: number[] = [];

  constructor(nodeCount: number) {
    this.nodeCount = nodeCount;
    this.head = new Array<number>(nodeCount).fill(-1);
  }

  addEdge(edge: FlowEdgeInput): void {
    const fwd = this.to.length;
    this.to.push(edge.to);
    this.cap.push(edge.capacity);
    this.cost.push(edge.cost);
    this.next.push(this.head[edge.from]!);
    this.head[edge.from] = fwd;

    this.to.push(edge.from);
    this.cap.push(0);
    this.cost.push(-edge.cost);
    this.next.push(this.head[edge.to]!);
    this.head[edge.to] = fwd + 1;

    this.forwardEdgeIndex.push(fwd);
    this.forwardEdgeCapacity.push(edge.capacity);
  }

  /** 从 source 向 sink 运送至多 maxFlow 的流量，费用最小。 */
  solve(source: number, sink: number, maxFlow: number): MinCostFlowResult {
    const n = this.nodeCount;
    const potential = this.initialPotentials(source);

    const dist = new Array<number>(n);
    const prevEdge = new Array<number>(n);

    let totalFlow = 0;
    while (totalFlow < maxFlow) {
      // Dijkstra（势能保证缩减费用非负）
      dist.fill(Infinity);
      prevEdge.fill(-1);
      dist[source] = 0;
      const heap = new MinHeap();
      heap.push(source, 0);
      while (heap.size > 0) {
        const v = heap.pop();
        if (heap.lastKey > dist[v]!) continue; // 惰性跳过过期的堆项
        const dv = dist[v]!;
        for (let e = this.head[v]!; e !== -1; e = this.next[e]!) {
          if (this.cap[e]! <= 0) continue;
          const w = this.to[e]!;
          const nd = dv + this.cost[e]! + potential[v]! - potential[w]!;
          if (nd < dist[w]!) {
            dist[w] = nd;
            prevEdge[w] = e;
            heap.push(w, nd);
          }
        }
      }
      if (dist[sink] === Infinity) break;

      for (let v = 0; v < n; v++) {
        if (dist[v]! < Infinity) potential[v]! += dist[v]!;
      }

      // 沿最短路径推送瓶颈流量
      let bottleneck = maxFlow - totalFlow;
      for (let e = prevEdge[sink]!; e !== -1; e = prevEdge[this.to[e ^ 1]!]!) {
        if (this.cap[e]! < bottleneck) bottleneck = this.cap[e]!;
      }
      for (let e = prevEdge[sink]!; e !== -1; e = prevEdge[this.to[e ^ 1]!]!) {
        this.cap[e]! -= bottleneck;
        this.cap[e ^ 1]! += bottleneck;
      }
      totalFlow += bottleneck;
    }

    const edgeFlows = new Array<number>(this.forwardEdgeIndex.length);
    for (let i = 0; i < this.forwardEdgeIndex.length; i++) {
      edgeFlows[i] = this.forwardEdgeCapacity[i]! - this.cap[this.forwardEdgeIndex[i]!]!;
    }
    return { totalFlow, edgeFlows };
  }

  /**
   * 初始势能：从 source 出发的一轮 Bellman-Ford（SPFA）。
   * 本库用法下初始图为 DAG，单轮即可收敛；保留通用实现以支持任意费用。
   */
  private initialPotentials(source: number): number[] {
    const n = this.nodeCount;
    const potential = new Array<number>(n).fill(Infinity);
    potential[source] = 0;
    const queue: number[] = [source];
    const inQueue = new Array<boolean>(n).fill(false);
    inQueue[source] = true;
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      inQueue[v] = false;
      for (let e = this.head[v]!; e !== -1; e = this.next[e]!) {
        if (this.cap[e]! <= 0) continue;
        const w = this.to[e]!;
        const nd = potential[v]! + this.cost[e]!;
        if (nd < potential[w]!) {
          potential[w] = nd;
          if (!inQueue[w]) {
            inQueue[w] = true;
            queue.push(w);
          }
        }
      }
    }
    // 不可达节点势能置 0，避免 Infinity 参与缩减费用计算
    for (let v = 0; v < n; v++) {
      if (potential[v] === Infinity) potential[v] = 0;
    }
    return potential;
  }
}

/** 以距离为键的二叉最小堆（允许重复入堆，弹出时惰性跳过过期项）。 */
class MinHeap {
  private nodes: number[] = [];
  private keys: number[] = [];
  /** 最近一次 pop 出的键。 */
  lastKey = 0;

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, key: number): void {
    // 允许同一节点多次入堆；pop 方需自行判断（本实现通过调用方 dist 数组比较）
    this.nodes.push(node);
    this.keys.push(key);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0]!;
    this.lastKey = this.keys[0]!;
    const lastNode = this.nodes.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const tn = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = tn;
    const tk = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = tk;
  }
}

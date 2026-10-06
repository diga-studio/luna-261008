import { CycleEvidence, Hop, SegmentId } from './types';

/** 有向图中的一条可用边及其胜出策略信息。 */
export interface Edge {
  readonly source: SegmentId;
  readonly destination: SegmentId;
  readonly action: Hop['action'];
  readonly priority: number;
}

/**
 * 在边集上寻找一条闭环：经过至少两个不同网段并返回起点，除首尾外不重复网段。
 * 找不到时返回 null。结果对同一输入是确定的（按网段标识排序遍历）。
 */
export function findCycle(segments: readonly SegmentId[], edges: readonly Edge[]): CycleEvidence | null {
  const adjacency = new Map<SegmentId, Edge[]>();
  for (const edge of edges) {
    if (edge.source === edge.destination) {
      continue; // 自环只经过一个网段，不构成闭环
    }
    const list = adjacency.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      adjacency.set(edge.source, [edge]);
    }
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
  }
  const orderedSegments = [...segments].sort();

  for (const start of orderedSegments) {
    const firstEdges = adjacency.get(start);
    if (!firstEdges) {
      continue;
    }
    // 迭代式 DFS：path 为当前网段路径，pathEdges 为对应的边，二者同步伸缩。
    const path: SegmentId[] = [start];
    const pathEdges: Edge[] = [];
    const visited = new Set<SegmentId>([start]);
    const iterators: Iterator<Edge>[] = [firstEdges[Symbol.iterator]()];

    while (iterators.length > 0) {
      const top = iterators[iterators.length - 1]!;
      const next = top.next();
      if (next.done) {
        // 当前节点已探完，回退一格并解除其访问标记。
        iterators.pop();
        const popped = path.pop();
        pathEdges.pop();
        if (popped !== undefined) {
          visited.delete(popped);
        }
        continue;
      }
      const edge = next.value;
      if (edge.destination === start && pathEdges.length >= 1) {
        // 回到起点且已跨过至少一条边：path 中至少有两个不同网段。
        return {
          segments: [...path, start],
          hops: [...pathEdges, edge],
        };
      }
      if (!visited.has(edge.destination)) {
        visited.add(edge.destination);
        path.push(edge.destination);
        pathEdges.push(edge);
        const nextEdges = adjacency.get(edge.destination);
        iterators.push(nextEdges ? nextEdges[Symbol.iterator]() : [][Symbol.iterator]());
      }
    }
  }
  return null;
}

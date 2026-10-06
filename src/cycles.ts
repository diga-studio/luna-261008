import type { Hop, SegmentId } from "./types.js";

/**
 * 在有向图中寻找一条经过至少两个不同网段并返回起点的闭环，
 * 除首尾外网段不重复。找不到返回 undefined。
 * 边以邻接表给出；自环边不构成有效闭环（闭环至少经过两个不同网段）。
 */
export function findCycle(adjacency: ReadonlyMap<SegmentId, readonly SegmentId[]>): Hop[] | undefined {
  const nodes = [...adjacency.keys()];
  const visited = new Set<SegmentId>();

  for (const start of nodes) {
    if (visited.has(start)) continue;
    // 迭代式 DFS，显式维护路径栈与每条边的游标。
    const stack: SegmentId[] = [start];
    const onPath = new Set<SegmentId>([start]);
    const cursors: number[] = [0];

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const edges = adjacency.get(top) ?? [];
      let advanced = false;
      while (cursors[cursors.length - 1]! < edges.length) {
        const next = edges[cursors[cursors.length - 1]!]!;
        cursors[cursors.length - 1]!++;
        if (next === top) continue; // 忽略自环
        if (onPath.has(next)) {
          // 找到闭环：从 next 在栈中的位置到栈顶，再回到 next。
          const idx = stack.indexOf(next);
          const cycleNodes = stack.slice(idx);
          if (cycleNodes.length < 2) continue; // 至少两个不同网段
          const hops: Hop[] = [];
          for (let i = 0; i < cycleNodes.length; i++) {
            hops.push({
              source: cycleNodes[i]!,
              target: cycleNodes[(i + 1) % cycleNodes.length]!,
            });
          }
          return hops;
        }
        if (!visited.has(next)) {
          stack.push(next);
          onPath.add(next);
          cursors.push(0);
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        const done = stack.pop()!;
        cursors.pop();
        onPath.delete(done);
        visited.add(done);
      }
    }
  }
  return undefined;
}

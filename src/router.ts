import { candidateIndices } from "./candidates.js";
import { optimizeBatch } from "./optimize.js";
import type { Assignment, Lead, RouteResult, TeamSnapshot } from "./types.js";

function validateSnapshot(snapshot: TeamSnapshot): void {
  const n = snapshot.roster.length;
  if (n === 0) return;
  if (
    !Number.isInteger(snapshot.rotationStart) ||
    snapshot.rotationStart < 0 ||
    snapshot.rotationStart >= n
  ) {
    throw new RangeError(
      `rotationStart 必须是 [0, ${n}) 内的整数，实际为 ${snapshot.rotationStart}`,
    );
  }
  for (const rep of snapshot.roster) {
    if (!Number.isInteger(rep.historicalCount) || rep.historicalCount < 0) {
      throw new RangeError(
        `销售 ${rep.id} 的 historicalCount 必须是非负整数，实际为 ${rep.historicalCount}`,
      );
    }
  }
}

/**
 * 路由一批按接收时间排序的 Hot 线索。
 *
 * 纯函数：不修改入参快照；相同快照与输入必产生相同结果。
 * 返回每条线索的分配结果，以及按最终选定方案更新后的团队状态
 * （累计数 + 轮转起点），可直接读出、持久化并作为下一批的输入。
 */
export function routeBatch(snapshot: TeamSnapshot, leads: Lead[]): RouteResult {
  validateSnapshot(snapshot);
  const roster = snapshot.roster;
  const n = roster.length;

  const candidatesPerLead = leads.map((lead) => candidateIndices(snapshot, lead));
  const historicalCounts = roster.map((rep) => rep.historicalCount);
  const chosen =
    n === 0
      ? leads.map(() => -1)
      : optimizeBatch(historicalCounts, snapshot.rotationStart, candidatesPerLead);

  const newCounts = historicalCounts.slice();
  let rotationStart = n === 0 ? 0 : snapshot.rotationStart;
  const assignments: Assignment[] = leads.map((lead, i) => {
    const repIndex = chosen[i];
    if (repIndex < 0) return { leadId: lead.id, repId: null };
    newCounts[repIndex] += 1;
    rotationStart = (repIndex + 1) % n;
    return { leadId: lead.id, repId: roster[repIndex].id };
  });

  return {
    assignments,
    state: {
      roster: roster.map((rep, i) => ({ ...rep, historicalCount: newCounts[i] })),
      rotationStart,
    },
  };
}

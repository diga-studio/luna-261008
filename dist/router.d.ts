import type { Lead, RouteResult, TeamSnapshot } from "./types.ts";
/**
 * Hot 线索路由器：进程内保存团队状态。
 * 每批在“满足技能的可用候选人”中搜索完整分配方案，
 * 最小化整批完成后的均衡值 sum((历史+新增)^2)；
 * 均衡值相同时按线索顺序比较轮转前进步数，步数序列字典序更小者优先。
 * 深度优先搜索按步数升序展开候选，因此首个达到最小均衡值的完整方案即最终方案。
 */
export declare class LeadRouter {
    private reps;
    private rotationStart;
    constructor(snapshot: TeamSnapshot);
    routeBatch(leads: Lead[]): RouteResult;
    getState(): TeamSnapshot;
}

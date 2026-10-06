import { candidateIndices } from "./matching.js";
/**
 * Hot 线索路由器：进程内保存团队状态。
 * 每批在“满足技能的可用候选人”中搜索完整分配方案，
 * 最小化整批完成后的均衡值 sum((历史+新增)^2)；
 * 均衡值相同时按线索顺序比较轮转前进步数，步数序列字典序更小者优先。
 * 深度优先搜索按步数升序展开候选，因此首个达到最小均衡值的完整方案即最终方案。
 */
export class LeadRouter {
    reps;
    rotationStart;
    constructor(snapshot) {
        this.reps = snapshot.reps.map((rep) => ({ ...rep, skills: rep.skills.map((s) => ({ ...s })) }));
        this.rotationStart = snapshot.rotationStart;
    }
    routeBatch(leads) {
        const n = this.reps.length;
        const base = this.reps.map((rep) => rep.assignedCount);
        const candidates = leads.map((lead) => candidateIndices(this.reps, lead));
        // suffixAssignable[i]：第 i 条及之后仍有候选人的线索数，用于剪枝下界。
        const suffixAssignable = new Array(leads.length + 1).fill(0);
        for (let i = leads.length - 1; i >= 0; i--) {
            suffixAssignable[i] = suffixAssignable[i + 1] + (candidates[i].length > 0 ? 1 : 0);
        }
        let bestSum = Number.POSITIVE_INFINITY;
        let bestChosen = null;
        const state = {
            counts: [...base],
            pointer: this.rotationStart,
            sum: base.reduce((acc, c) => acc + c * c, 0),
            steps: [],
            chosen: new Array(leads.length).fill(null),
        };
        const dfs = (i) => {
            if (i === leads.length) {
                if (state.sum < bestSum) {
                    bestSum = state.sum;
                    bestChosen = [...state.chosen];
                }
                return;
            }
            // 下界剪枝：每条剩余可分配线索至少让最小计数加一。
            if (bestSum !== Number.POSITIVE_INFINITY) {
                const minCount = Math.min(...state.counts);
                const lowerBound = state.sum + suffixAssignable[i] * (2 * minCount + 1);
                if (lowerBound >= bestSum)
                    return;
            }
            const cands = candidates[i];
            if (cands.length === 0) {
                state.chosen[i] = null;
                dfs(i + 1);
                return;
            }
            const ordered = [...cands].sort((a, b) => (a - state.pointer + n) % n - ((b - state.pointer + n) % n));
            for (const r of ordered) {
                const step = (r - state.pointer + n) % n;
                state.counts[r] += 1;
                state.sum += 2 * (state.counts[r] - 1) + 1;
                const prevPointer = state.pointer;
                state.pointer = (r + 1) % n;
                state.steps.push(step);
                state.chosen[i] = r;
                dfs(i + 1);
                state.chosen[i] = null;
                state.steps.pop();
                state.pointer = prevPointer;
                state.sum -= 2 * (state.counts[r] - 1) + 1;
                state.counts[r] -= 1;
            }
        };
        dfs(0);
        const chosen = bestChosen ?? leads.map(() => null);
        const assignments = leads.map((lead, i) => ({
            leadId: lead.id,
            assignee: chosen[i] === null ? null : this.reps[chosen[i]].id,
        }));
        // 按最终选定方案回放，更新累计数与轮转起点。
        let pointer = this.rotationStart;
        for (let i = 0; i < leads.length; i++) {
            const r = chosen[i];
            if (r === null)
                continue;
            this.reps[r].assignedCount += 1;
            pointer = (r + 1) % n;
        }
        this.rotationStart = pointer;
        return { assignments };
    }
    getState() {
        return {
            reps: this.reps.map((rep) => ({ ...rep, skills: rep.skills.map((s) => ({ ...s })) })),
            rotationStart: this.rotationStart,
        };
    }
}

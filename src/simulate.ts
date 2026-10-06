import { sampleIndex } from "./rng.js";
import type { ReplayResult, Scenario, SimInput, StepRecord } from "./types.js";

/** 通用二叉最小堆。 */
class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}
  get size(): number {
    return this.items.length;
  }
  peek(): T {
    const v = this.items[0];
    if (v === undefined) throw new Error("heap empty");
    return v;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(item, items[p]!)) {
        items[i] = items[p]!;
        i = p;
      } else break;
    }
    items[i] = item;
  }
  pop(): T {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l]!, items[m]!)) m = l;
        if (r < items.length && this.less(items[r]!, items[m]!)) m = r;
        if (m === i) break;
        const tmp = items[i]!;
        items[i] = items[m]!;
        items[m] = tmp;
        i = m;
      }
    }
    if (top === undefined) throw new Error("heap empty");
    return top;
  }
}

interface ReadyStep {
  ready: number;
  caseId: string;
  caseIdx: number;
  pos: number;
}

interface RunningEntry {
  end: number;
  caseIdx: number;
  actIdx: number;
}

interface ActivityState {
  name: string;
  /** 升序排序后的样本，保证与样本输入顺序无关。 */
  samples: number[];
  capacity: number;
  /** 缩短百分比（1..99），0 表示不缩短。 */
  shortenPct: number;
  inFlight: number;
  queue: MinHeap<ReadyStep>;
}

interface RetainedStep {
  activity: string;
  origIndex: number;
}

interface CaseState {
  id: string;
  arrival: number;
  steps: RetainedStep[];
  nextPos: number;
  completion: number;
}

/**
 * 执行一轮事件驱动仿真。
 * collectSteps 为 false 时不记录步骤轨迹（供 compare 使用，避免保留完整轨迹）。
 */
export function runSimulation(
  input: SimInput,
  scenario: Scenario,
  seed: number,
  round: number,
  collectSteps = true,
): ReplayResult {
  const removed = new Set(scenario.remove ?? []);
  const shorten = scenario.shorten ?? {};
  const capOverride = scenario.capacity ?? {};

  const actIndex = new Map<string, number>();
  const acts: ActivityState[] = [];
  for (const name of Object.keys(input.activities)) {
    const def = input.activities[name]!;
    actIndex.set(name, acts.length);
    acts.push({
      name,
      samples: [...def.samples].sort((a, b) => a - b),
      capacity: capOverride[name] ?? def.capacity,
      shortenPct: shorten[name] ?? 0,
      inFlight: 0,
      queue: new MinHeap<ReadyStep>((a, b) =>
        a.ready !== b.ready ? a.ready < b.ready : a.caseId < b.caseId,
      ),
    });
  }

  const cases: CaseState[] = input.cases.map((c) => {
    const steps: RetainedStep[] = [];
    for (let i = 0; i < c.activities.length; i++) {
      const activity = c.activities[i]!;
      if (!removed.has(activity)) steps.push({ activity, origIndex: i });
    }
    return { id: c.id, arrival: c.arrival, steps, nextPos: 0, completion: -1 };
  });

  const arrivalOrder = cases.map((_, i) => i);
  arrivalOrder.sort((a, b) => cases[a]!.arrival - cases[b]!.arrival);
  let arrivalPtr = 0;

  const running = new MinHeap<RunningEntry>((a, b) => a.end < b.end);
  const stepsOut: StepRecord[] = [];
  let queuedCount = 0;

  const enqueueReady = (caseIdx: number, time: number): void => {
    const c = cases[caseIdx]!;
    if (c.nextPos < c.steps.length) {
      const s = c.steps[c.nextPos]!;
      c.nextPos++;
      acts[actIndex.get(s.activity)!]!.queue.push({
        ready: time,
        caseId: c.id,
        caseIdx,
        pos: c.nextPos - 1,
      });
      queuedCount++;
    } else {
      c.completion = time;
    }
  };

  let t = 0;
  while (arrivalPtr < cases.length || running.size > 0 || queuedCount > 0) {
    let next = Infinity;
    if (arrivalPtr < cases.length) {
      next = Math.min(next, cases[arrivalOrder[arrivalPtr]!]!.arrival);
    }
    if (running.size > 0) next = Math.min(next, running.peek().end);
    if (!Number.isFinite(next)) break;
    t = next;

    // 同一时刻：先处理全部完成事件
    while (running.size > 0 && running.peek().end === t) {
      const e = running.pop();
      acts[e.actIdx]!.inFlight--;
      enqueueReady(e.caseIdx, t);
    }
    // 再处理外部到达
    while (arrivalPtr < cases.length && cases[arrivalOrder[arrivalPtr]!]!.arrival === t) {
      enqueueReady(arrivalOrder[arrivalPtr]!, t);
      arrivalPtr++;
    }
    // 批量派发；本批零时长步骤在下一批同一时刻完成，级联直到无即时事件
    for (;;) {
      const zeroDone: RunningEntry[] = [];
      for (let ai = 0; ai < acts.length; ai++) {
        const act = acts[ai]!;
        while (act.inFlight < act.capacity && act.queue.size > 0) {
          const r = act.queue.pop();
          queuedCount--;
          const c = cases[r.caseIdx]!;
          const step = c.steps[r.pos]!;
          const raw =
            act.samples[sampleIndex(seed, round, c.id, step.origIndex, act.samples.length)]!;
          const dur =
            act.shortenPct > 0
              ? Math.floor((raw * (100 - act.shortenPct)) / 100)
              : raw;
          act.inFlight++;
          if (collectSteps) {
            stepsOut.push({
              caseId: c.id,
              index: step.origIndex,
              activity: act.name,
              ready: r.ready,
              start: t,
              end: t + dur,
            });
          }
          if (dur === 0) {
            zeroDone.push({ end: t, caseIdx: r.caseIdx, actIdx: ai });
          } else {
            running.push({ end: t + dur, caseIdx: r.caseIdx, actIdx: ai });
          }
        }
      }
      if (zeroDone.length === 0) break;
      for (const z of zeroDone) {
        acts[z.actIdx]!.inFlight--;
        enqueueReady(z.caseIdx, t);
      }
    }
  }

  if (collectSteps) {
    stepsOut.sort((a, b) =>
      a.caseId !== b.caseId ? (a.caseId < b.caseId ? -1 : 1) : a.index - b.index,
    );
  }
  const completions = cases
    .map((c) => ({ caseId: c.id, completion: c.completion }))
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  return { steps: stepsOut, completions };
}

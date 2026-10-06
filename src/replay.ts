import type { ReplayResult, Scenario, SimulationInput, StepRecord } from "./types";
import { createSampler } from "./rng";

/** Binary min-heap with a user-supplied "less" comparator. */
class Heap<T> {
  private items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(item, items[parent] as T)) break;
      items[i] = items[parent] as T;
      i = parent;
    }
    items[i] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.less(items[left] as T, items[smallest] as T)) smallest = left;
        if (right < items.length && this.less(items[right] as T, items[smallest] as T)) smallest = right;
        if (smallest === i) break;
        items[i] = items[smallest] as T;
        i = smallest;
      }
      items[i] = last;
    }
    return top;
  }
}

interface QueuedStep {
  ready: number;
  caseId: string;
  caseIdx: number;
  /** Position within the case's retained-step list. */
  retainedPos: number;
}

interface Completion {
  end: number;
  seq: number;
  activityIdx: number;
  caseIdx: number;
  retainedPos: number;
}

interface ActivityState {
  samples: number[];
  capacity: number;
  shortenPct: number;
  running: number;
  queue: Heap<QueuedStep>;
}

interface CaseState {
  id: string;
  arrival: number;
  /** Activity indices of retained steps, in execution order. */
  retained: number[];
  /** Original step indices (into the input path) of retained steps. */
  originalIndices: number[];
}

/**
 * Run a single simulation round.
 *
 * @param input    trusted workload
 * @param scenario modifications; `{}` means baseline
 * @param seed     sampling seed
 * @param round    round index feeding the deterministic sampler
 */
export function replay(
  input: SimulationInput,
  scenario: Scenario,
  seed: number | string,
  round: number,
): ReplayResult {
  const sampler = createSampler(seed, round);

  const removed = new Set(scenario.remove ?? []);
  const shorten = scenario.shorten ?? {};
  const capacityOverride = scenario.capacity ?? {};

  const activityIndexById = new Map<string, number>();
  const activities: ActivityState[] = input.activities.map((def, idx) => {
    activityIndexById.set(def.id, idx);
    return {
      samples: def.samples,
      capacity: capacityOverride[def.id] ?? def.capacity,
      shortenPct: shorten[def.id] ?? 0,
      running: 0,
      queue: new Heap<QueuedStep>((a, b) =>
        a.ready !== b.ready ? a.ready < b.ready : a.caseId < b.caseId,
      ),
    };
  });

  const cases: CaseState[] = input.cases.map((def) => {
    const retained: number[] = [];
    const originalIndices: number[] = [];
    def.path.forEach((activityId, stepIdx) => {
      if (removed.has(activityId)) return;
      const activityIdx = activityIndexById.get(activityId);
      if (activityIdx === undefined) {
        throw new Error(`unknown activity "${activityId}" in case "${def.id}"`);
      }
      retained.push(activityIdx);
      originalIndices.push(stepIdx);
    });
    return { id: def.id, arrival: def.arrival, retained, originalIndices };
  });

  // External arrivals sorted by time; ties are irrelevant because dispatch
  // order is decided by the per-activity (ready, caseId) queues.
  const arrivalOrder = cases
    .map((_, idx) => idx)
    .sort((a, b) => (cases[a] as CaseState).arrival - (cases[b] as CaseState).arrival);
  let arrivalPtr = 0;

  let completionSeq = 0;
  const completions = new Heap<Completion>((a, b) =>
    a.end !== b.end ? a.end < b.end : a.seq < b.seq,
  );

  const steps: StepRecord[] = [];
  const caseCompletions: Record<string, number> = {};

  const enqueueStep = (caseIdx: number, retainedPos: number, ready: number): void => {
    const caseState = cases[caseIdx] as CaseState;
    const activityIdx = caseState.retained[retainedPos] as number;
    (activities[activityIdx] as ActivityState).queue.push({
      ready,
      caseId: caseState.id,
      caseIdx,
      retainedPos,
    });
  };

  const arriveCase = (caseIdx: number, time: number): void => {
    const caseState = cases[caseIdx] as CaseState;
    if (caseState.retained.length === 0) {
      caseCompletions[caseState.id] = time;
      return;
    }
    enqueueStep(caseIdx, 0, time);
  };

  const dispatchReady = (time: number): void => {
    // Iteration order across activities cannot affect the result: pools and
    // queues are independent per activity.
    for (let activityIdx = 0; activityIdx < activities.length; activityIdx++) {
      const activity = activities[activityIdx] as ActivityState;
      while (activity.running < activity.capacity && activity.queue.size > 0) {
        const head = activity.queue.pop() as QueuedStep;
        const caseState = cases[head.caseIdx] as CaseState;
        const stepIndex = caseState.originalIndices[head.retainedPos] as number;
        const raw = sampler.sample(caseState.id, stepIndex, activity.samples);
        const duration =
          activity.shortenPct > 0
            ? Math.floor((raw * (100 - activity.shortenPct)) / 100)
            : raw;
        activity.running++;
        steps.push({
          caseId: caseState.id,
          activityId: (input.activities[activityIdx] as { id: string }).id,
          stepIndex,
          ready: head.ready,
          start: time,
          end: time + duration,
        });
        completions.push({
          end: time + duration,
          seq: completionSeq++,
          activityIdx,
          caseIdx: head.caseIdx,
          retainedPos: head.retainedPos,
        });
      }
    }
  };

  for (;;) {
    // Next timestamp with anything to do: an external arrival or a completion.
    let nextTime = Infinity;
    if (arrivalPtr < arrivalOrder.length) {
      nextTime = (cases[arrivalOrder[arrivalPtr] as number] as CaseState).arrival;
    }
    const topCompletion = completions.peek();
    if (topCompletion !== undefined && topCompletion.end < nextTime) {
      nextTime = topCompletion.end;
    }
    if (nextTime === Infinity) break;

    // 1) All completions at this time release workstations and enqueue successors.
    while (completions.peek()?.end === nextTime) {
      const done = completions.pop() as Completion;
      const activity = activities[done.activityIdx] as ActivityState;
      activity.running--;
      const caseState = cases[done.caseIdx] as CaseState;
      if (done.retainedPos + 1 < caseState.retained.length) {
        enqueueStep(done.caseIdx, done.retainedPos + 1, nextTime);
      } else {
        caseCompletions[caseState.id] = nextTime;
      }
    }

    // 2) All external arrivals at this time enter their first queue.
    while (arrivalPtr < arrivalOrder.length) {
      const caseIdx = arrivalOrder[arrivalPtr] as number;
      if ((cases[caseIdx] as CaseState).arrival !== nextTime) break;
      arriveCase(caseIdx, nextTime);
      arrivalPtr++;
    }

    // 3) Batch-dispatch every activity. Zero-duration steps pushed completion
    //    events at this same timestamp, so the outer loop repeats the batch
    //    at this time until no immediate events remain.
    dispatchReady(nextTime);
  }

  return { steps, completions: caseCompletions };
}

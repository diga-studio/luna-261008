import { validateDefinition } from './definition.js';
import type {
  ExecutionResult,
  FiredReminder,
  ProcessDefinition,
  StepDefinition,
  StepResult,
  StepStatus,
} from './types.js';

interface StepState {
  def: StepDefinition;
  predecessors: string[];
  successors: string[];
  status: StepStatus;
  round: number;
  waitStartedAt: number | null;
  completedAt: number | null;
  confirmedAt: number | null;
  /** 等待计时已结束，但仍在等待人工确认 */
  timerExpired: boolean;
  /** 已产生的提醒历史（含以往轮次） */
  reminders: FiredReminder[];
}

type QueueEvent =
  | { kind: 'timer'; time: number; seq: number; stepId: string; round: number }
  | { kind: 'reminder'; time: number; seq: number; stepId: string; round: number; offsetMs: number };

/** 简易二叉最小堆，按 (time, seq) 排序，保证同一毫秒内按入队顺序处理。 */
class EventHeap {
  private items: QueueEvent[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): QueueEvent | undefined {
    return this.items[0];
  }

  push(event: QueueEvent): void {
    const items = this.items;
    items.push(event);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): QueueEvent | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.less(items[left], items[smallest])) smallest = left;
        if (right < items.length && this.less(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }

  private less(a: QueueEvent, b: QueueEvent): boolean {
    return a.time !== b.time ? a.time < b.time : a.seq < b.seq;
  }
}

/** 现场工序执行实例：定义与运行状态全部保存在内存，调用顺序进行。 */
export class ProcessExecution {
  private readonly states = new Map<string, StepState>();
  private readonly topoOrder: string[];
  private readonly heap = new EventHeap();
  private seq = 0;
  private now: number;

  constructor(definition: ProcessDefinition, startTime: number) {
    validateDefinition(definition);
    if (!Number.isInteger(startTime)) {
      throw new Error('startTime must be an integer millisecond timestamp');
    }
    this.now = startTime;

    const indegree = new Map<string, number>();
    for (const stepDef of definition.steps) {
      this.states.set(stepDef.id, {
        def: stepDef,
        predecessors: [],
        successors: [],
        status: 'locked',
        round: 1,
        waitStartedAt: null,
        completedAt: null,
        confirmedAt: null,
        timerExpired: false,
        reminders: [],
      });
      indegree.set(stepDef.id, 0);
    }
    for (const dep of definition.dependencies) {
      this.states.get(dep.from)?.successors.push(dep.to);
      this.states.get(dep.to)?.predecessors.push(dep.from);
      indegree.set(dep.to, (indegree.get(dep.to) as number) + 1);
    }

    // 拓扑序（定义无环，由 validateDefinition 保证）
    const order: string[] = [];
    const queue: string[] = [];
    for (const [id, deg] of indegree) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length > 0) {
      const id = queue.shift() as string;
      order.push(id);
      for (const next of this.states.get(id)?.successors ?? []) {
        const deg = (indegree.get(next) as number) - 1;
        indegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    this.topoOrder = order;

    // 没有前置依赖的步骤在开始时刻解锁
    for (const id of this.topoOrder) {
      const state = this.states.get(id) as StepState;
      if (state.predecessors.length === 0) {
        this.unlock(state, startTime);
      }
    }
    this.processUntil(startTime);
  }

  /** 推进业务时间到 now（非递减）。 */
  advanceTime(now: number): void {
    this.checkTime(now);
    this.processUntil(now);
    this.now = now;
  }

  /** 在时刻 now 对步骤 stepId 提交现场确认。 */
  confirm(stepId: string, now: number): void {
    this.checkTime(now);
    this.processUntil(now);
    this.now = now;

    const state = this.requireStep(stepId);
    if (state.status === 'locked') {
      throw new Error(`step ${stepId} is locked and cannot be confirmed`);
    }
    if (state.status === 'completed' || state.confirmedAt !== null) {
      return; // 重复确认不改变任何状态
    }
    state.confirmedAt = now;

    if (state.def.kind === 'manual') {
      this.complete(state, now);
    } else if (state.def.requiresConfirmation && state.timerExpired) {
      // 计时已结束，确认是最后一个满足的条件
      this.complete(state, now);
    }
    // 计时未结束的等待步骤：仅记录确认，等计时事件触发时完成
  }

  /** 在时刻 now 回退步骤 stepId：目标及其全部直接、间接后继的本轮结果失效。 */
  revert(stepId: string, now: number): void {
    this.checkTime(now);
    this.processUntil(now);
    this.now = now;

    const target = this.requireStep(stepId);
    if (target.status === 'locked') {
      throw new Error(`step ${stepId} is locked and cannot be reverted`);
    }

    // 影响范围：目标 + 所有直接、间接后继
    const affected = new Set<string>();
    const stack = [stepId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (affected.has(id)) continue;
      affected.add(id);
      for (const next of (this.states.get(id) as StepState).successors) {
        stack.push(next);
      }
    }

    // 本轮完成结果、人工确认、计时失效；递增轮次使未触发的旧提醒/计时事件作废
    for (const id of affected) {
      const state = this.states.get(id) as StepState;
      state.status = 'locked';
      state.round += 1;
      state.waitStartedAt = null;
      state.completedAt = null;
      state.confirmedAt = null;
      state.timerExpired = false;
    }

    // 重新判断依赖：前置全部完成的立即解锁，等待步骤从回退时刻重新计时
    for (const id of this.topoOrder) {
      if (!affected.has(id)) continue;
      const state = this.states.get(id) as StepState;
      if (state.status === 'locked' && this.allPredecessorsCompleted(state)) {
        this.unlock(state, now);
      }
    }
    this.processUntil(now);
  }

  /** 查看当前执行结果。 */
  getResult(): ExecutionResult {
    const steps: StepResult[] = [];
    for (const id of this.topoOrder) {
      const state = this.states.get(id) as StepState;
      steps.push({
        id,
        status: state.status,
        round: state.round,
        waitStartedAt: state.waitStartedAt,
        completedAt: state.completedAt,
        confirmedAt: state.confirmedAt,
        reminders: state.reminders.map((r) => ({ ...r })),
      });
    }
    return { now: this.now, steps };
  }

  private checkTime(now: number): void {
    if (!Number.isInteger(now)) {
      throw new Error('time must be an integer millisecond timestamp');
    }
    if (now < this.now) {
      throw new Error(`time cannot go backwards: ${now} < ${this.now}`);
    }
  }

  private requireStep(stepId: string): StepState {
    const state = this.states.get(stepId);
    if (!state) {
      throw new Error(`unknown step: ${stepId}`);
    }
    return state;
  }

  private allPredecessorsCompleted(state: StepState): boolean {
    return state.predecessors.every(
      (id) => (this.states.get(id) as StepState).status === 'completed',
    );
  }

  private unlock(state: StepState, time: number): void {
    state.status = 'unlocked';
    if (state.def.kind === 'wait') {
      state.waitStartedAt = time;
      state.timerExpired = false;
      const duration = state.def.durationMs as number;
      this.pushEvent({ kind: 'timer', time: time + duration, seq: 0, stepId: state.def.id, round: state.round });
      for (const offset of state.def.reminders ?? []) {
        this.pushEvent({
          kind: 'reminder',
          time: time + offset,
          seq: 0,
          stepId: state.def.id,
          round: state.round,
          offsetMs: offset,
        });
      }
    }
  }

  private complete(state: StepState, time: number): void {
    state.status = 'completed';
    state.completedAt = time;
    // 自动完成立即解锁后继
    for (const nextId of state.successors) {
      const next = this.states.get(nextId) as StepState;
      if (next.status === 'locked' && this.allPredecessorsCompleted(next)) {
        this.unlock(next, time);
      }
    }
  }

  private pushEvent(event: QueueEvent): void {
    event.seq = this.seq++;
    this.heap.push(event);
  }

  /** 处理截至 now 的全部到期提醒与自动完成（同一毫秒的事件全部先于该毫秒的现场操作）。 */
  private processUntil(now: number): void {
    for (;;) {
      const event = this.heap.peek();
      if (!event || event.time > now) return;
      this.heap.pop();
      const state = this.states.get(event.stepId) as StepState;
      if (state.round !== event.round) continue; // 旧轮次事件，已作废
      if (event.kind === 'reminder') {
        if (state.status === 'unlocked') {
          state.reminders.push({ offsetMs: event.offsetMs, firedAt: event.time, round: event.round });
        }
        continue;
      }
      // timer 事件
      if (state.status !== 'unlocked' || state.timerExpired) continue;
      state.timerExpired = true;
      if (!state.def.requiresConfirmation || state.confirmedAt !== null) {
        // 确认（若有）必然不晚于当前事件时刻，完成时刻即计时结束时刻
        this.complete(state, event.time);
      }
      // 需要确认但尚未确认：阻断后继，等待 confirm
    }
  }
}

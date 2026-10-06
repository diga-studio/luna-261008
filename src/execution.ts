import type {
  ExecutionResult,
  ProcessDefinition,
  ReminderRecord,
  StepDefinition,
  StepResult,
  StepStatus,
} from "./types.js";
import { validateDefinition } from "./definition.js";

interface StepState {
  readonly def: StepDefinition;
  readonly predecessors: string[];
  readonly successors: string[];
  status: StepStatus;
  /** 当前执行轮次，回退时递增，用于作废旧轮已调度的事件 */
  round: number;
  waitStartedAt: number | null;
  confirmedAt: number | null;
  completedAt: number | null;
  /** 本轮已触发过的提醒偏移 */
  readonly firedReminders: Set<number>;
}

const enum EventKind {
  Timer = 0,
  Reminder = 1,
}

interface ScheduledEvent {
  readonly time: number;
  readonly seq: number;
  readonly stepId: string;
  readonly round: number;
  readonly kind: EventKind;
  readonly offset: number;
}

/** 按 (time, seq) 排序的二叉最小堆 */
class EventHeap {
  private items: ScheduledEvent[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): ScheduledEvent | undefined {
    return this.items[0];
  }

  push(event: ScheduledEvent): void {
    const items = this.items;
    items.push(event);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.before(items[index], items[parent])) {
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      } else {
        break;
      }
    }
  }

  pop(): ScheduledEvent | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.before(items[left], items[smallest])) {
          smallest = left;
        }
        if (right < items.length && this.before(items[right], items[smallest])) {
          smallest = right;
        }
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return top;
  }

  private before(a: ScheduledEvent, b: ScheduledEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }
}

/**
 * 现场工序执行实例。同一实例的调用按顺序进行，不考虑并发。
 */
export class ProcessExecution {
  private readonly states = new Map<string, StepState>();
  private readonly topoOrder: string[];
  private readonly heap = new EventHeap();
  private readonly reminderLog: ReminderRecord[] = [];
  private currentTime: number;
  private nextSeq = 0;

  constructor(definition: ProcessDefinition, startTime: number) {
    if (!Number.isInteger(startTime)) {
      throw new Error("startTime must be an integer");
    }
    this.topoOrder = validateDefinition(definition);
    this.currentTime = startTime;

    for (const step of definition.steps) {
      this.states.set(step.id, {
        def: step,
        predecessors: [...(step.dependsOn ?? [])],
        successors: [],
        status: "locked",
        round: 0,
        waitStartedAt: null,
        confirmedAt: null,
        completedAt: null,
        firedReminders: new Set(),
      });
    }
    for (const step of definition.steps) {
      for (const dep of step.dependsOn ?? []) {
        this.states.get(dep)!.successors.push(step.id);
      }
    }

    // 没有前置依赖的步骤在本次执行的开始时刻解锁。
    for (const id of this.topoOrder) {
      const state = this.states.get(id)!;
      if (state.predecessors.length === 0) {
        this.unlock(state, startTime);
      }
    }
  }

  /** 推进业务时间（非递减整数毫秒） */
  advanceTime(now: number): void {
    if (!Number.isInteger(now) || now < this.currentTime) {
      throw new Error(`invalid business time: ${now}`);
    }
    this.processDueEvents(now);
    this.currentTime = now;
  }

  /** 提交现场确认：先处理截至该时刻的到期事件，再应用确认 */
  confirm(stepId: string, at: number): void {
    this.advanceTime(at);
    const state = this.requireStep(stepId);
    if (state.status === "locked") {
      throw new Error(`step ${stepId} is locked and cannot be confirmed`);
    }
    if (state.status === "completed") {
      return; // 重复确认不改变任何事实
    }
    if (state.def.kind === "manual") {
      this.complete(state, at);
      return;
    }
    // 等待步骤：只记录首次确认；完成时刻取计时结束与确认两者最后满足的时刻。
    if (state.confirmedAt === null) {
      state.confirmedAt = at;
    }
    const timerEnd = state.waitStartedAt! + state.def.durationMs!;
    if (timerEnd <= at) {
      this.complete(state, at);
    }
  }

  /** 回退一个已解锁或已完成的步骤，影响其全部直接、间接后继 */
  rollback(stepId: string, at: number): void {
    this.advanceTime(at);
    const target = this.requireStep(stepId);
    if (target.status === "locked") {
      throw new Error(`step ${stepId} is locked and cannot be rolled back`);
    }

    // 受影响范围：目标及其全部直接、间接后继。
    const affected = new Set<string>();
    const stack = [stepId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (affected.has(id)) continue;
      affected.add(id);
      for (const next of this.states.get(id)!.successors) {
        stack.push(next);
      }
    }

    // 本轮完成结果、确认与计时全部失效；旧轮未触发事件随 round 递增而作废。
    for (const id of affected) {
      const state = this.states.get(id)!;
      state.round += 1;
      state.status = "locked";
      state.waitStartedAt = null;
      state.confirmedAt = null;
      state.completedAt = null;
      state.firedReminders.clear();
    }

    // 重新判断依赖：前置全部完成的立即解锁，等待步骤从回退时刻重新计时。
    for (const id of this.topoOrder) {
      if (!affected.has(id)) continue;
      const state = this.states.get(id)!;
      if (state.predecessors.every((dep) => this.states.get(dep)!.status === "completed")) {
        this.unlock(state, at);
      }
    }
  }

  /** 查看执行结果 */
  getResult(): ExecutionResult {
    const steps: Record<string, StepResult> = {};
    for (const [id, state] of this.states) {
      steps[id] = {
        id,
        status: state.status,
        waitStartedAt: state.waitStartedAt,
        confirmedAt: state.confirmedAt,
        completedAt: state.completedAt,
      };
    }
    return {
      currentTime: this.currentTime,
      steps,
      reminders: [...this.reminderLog],
    };
  }

  private requireStep(stepId: string): StepState {
    const state = this.states.get(stepId);
    if (!state) {
      throw new Error(`unknown step: ${stepId}`);
    }
    return state;
  }

  private unlock(state: StepState, at: number): void {
    state.status = "unlocked";
    if (state.def.kind !== "wait") return;
    state.waitStartedAt = at;
    this.schedule(state, at + state.def.durationMs!, EventKind.Timer, 0);
    for (const offset of state.def.reminders ?? []) {
      this.schedule(state, at + offset, EventKind.Reminder, offset);
    }
  }

  private schedule(state: StepState, time: number, kind: EventKind, offset: number): void {
    this.heap.push({
      time,
      seq: this.nextSeq++,
      stepId: state.def.id,
      round: state.round,
      kind,
      offset,
    });
  }

  private complete(state: StepState, at: number): void {
    state.status = "completed";
    state.completedAt = at;
    // 自动完成立即解锁后继；后继等待从实际达成时刻开始计时。
    for (const nextId of state.successors) {
      const next = this.states.get(nextId)!;
      if (
        next.status === "locked" &&
        next.predecessors.every((dep) => this.states.get(dep)!.status === "completed")
      ) {
        this.unlock(next, at);
      }
    }
  }

  private processDueEvents(upTo: number): void {
    for (;;) {
      const event = this.heap.peek();
      if (!event || event.time > upTo) return;
      this.heap.pop();
      const state = this.states.get(event.stepId)!;
      if (state.round !== event.round) continue; // 旧轮事件已作废
      if (state.status !== "unlocked") continue;
      if (event.kind === EventKind.Reminder) {
        if (state.firedReminders.has(event.offset)) continue;
        state.firedReminders.add(event.offset);
        this.reminderLog.push({
          stepId: event.stepId,
          offsetMs: event.offset,
          at: event.time,
          round: event.round,
        });
        continue;
      }
      // 计时结束：需要人工确认且尚未确认的等待会阻断后继。
      const requiresConfirmation = state.def.requiresConfirmation === true;
      if (!requiresConfirmation || (state.confirmedAt !== null && state.confirmedAt <= event.time)) {
        this.complete(state, event.time);
      }
    }
  }
}

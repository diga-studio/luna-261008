import { AdmissionService } from '../src/index.js';
import type { SeatAssignedEvent, SeatNotifier } from '../src/index.js';

export interface TestHarness {
  service: AdmissionService;
  events: SeatAssignedEvent[];
  clock: { now: () => number; tick: (ms: number) => void; current: () => number };
}

export function makeHarness(options?: {
  capacity?: number;
  holdMs?: number;
  start?: number;
  notify?: SeatNotifier;
  dbPath?: string;
}): TestHarness {
  let now = options?.start ?? 1_000_000;
  const events: SeatAssignedEvent[] = [];
  const service = new AdmissionService({
    dbPath: options?.dbPath ?? ':memory:',
    capacity: options?.capacity ?? 2,
    holdMs: options?.holdMs,
    now: () => now,
    notify:
      options?.notify ??
      (async (event) => {
        events.push(event);
      }),
  });
  return {
    service,
    events,
    clock: {
      now: () => now,
      tick: (ms: number) => {
        now += ms;
      },
      current: () => now,
    },
  };
}

import { ChannelAdmission } from '../src/index.js';
import type { AdmissionOptions } from '../src/index.js';

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
}

export function makeClock(start = 1_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

export interface NotifyEvent {
  channelId: string;
  requestId: string;
  userId: string;
}

export interface Harness {
  admission: ChannelAdmission;
  clock: FakeClock;
  events: NotifyEvent[];
}

export function makeHarness(
  capacity: number,
  options: Partial<AdmissionOptions> = {},
  start = 1_000_000,
): Harness {
  const clock = makeClock(start);
  const events: NotifyEvent[] = [];
  const admission = new ChannelAdmission({
    dbPath: ':memory:',
    capacity,
    now: clock.now,
    notifier: async (e) => {
      events.push(e);
    },
    ...options,
  });
  return { admission, clock, events };
}

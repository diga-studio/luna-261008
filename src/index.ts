export type Classification = "RATE_ABUSE" | "ENDPOINT_SCAN";

export interface TrafficGuardOptions {
  rateWindowMs?: number;
  rateMaxRequests?: number;
  scanWindowMs?: number;
  scanMaxEndpoints?: number;
}

interface IpState {
  // endpoint -> queue of request timestamps (array + head index, no O(n) shift)
  rateQueues: Map<string, { ts: number[]; head: number }>;
  // endpoint -> most recent request timestamp within the scan window
  lastSeen: Map<string, number>;
  // FIFO of [lastSeen, endpoint]; stale entries are skipped lazily
  scanQueue: Array<[number, string]>;
  scanHead: number;
  // number of distinct endpoints with lastSeen > now - scanWindowMs
  scanCount: number;
}

const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX_REQUESTS = 100;
const DEFAULT_SCAN_WINDOW_MS = 300_000;
const DEFAULT_SCAN_MAX_ENDPOINTS = 20;

export class TrafficGuard {
  private readonly rateWindowMs: number;
  private readonly rateMaxRequests: number;
  private readonly scanWindowMs: number;
  private readonly scanMaxEndpoints: number;

  private readonly ips = new Map<string, IpState>();

  constructor(options?: TrafficGuardOptions) {
    this.rateWindowMs = options?.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.rateMaxRequests = options?.rateMaxRequests ?? DEFAULT_RATE_MAX_REQUESTS;
    this.scanWindowMs = options?.scanWindowMs ?? DEFAULT_SCAN_WINDOW_MS;
    this.scanMaxEndpoints = options?.scanMaxEndpoints ?? DEFAULT_SCAN_MAX_ENDPOINTS;
  }

  observe(ip: string, endpoint: string, t: number): Set<Classification> {
    this.advance(t);
    let state = this.ips.get(ip);
    if (state === undefined) {
      state = { rateQueues: new Map(), lastSeen: new Map(), scanQueue: [], scanHead: 0, scanCount: 0 };
      this.ips.set(ip, state);
    }

    let queue = state.rateQueues.get(endpoint);
    if (queue === undefined) {
      queue = { ts: [], head: 0 };
      state.rateQueues.set(endpoint, queue);
    }
    queue.ts.push(t);

    if (!state.lastSeen.has(endpoint)) {
      state.scanCount += 1;
    }
    state.lastSeen.set(endpoint, t);
    state.scanQueue.push([t, endpoint]);

    const hits = new Set<Classification>();
    if (queue.ts.length - queue.head > this.rateMaxRequests) {
      hits.add("RATE_ABUSE");
    }
    if (state.scanCount > this.scanMaxEndpoints) {
      hits.add("ENDPOINT_SCAN");
    }
    return hits;
  }

  advance(t: number): void {
    const rateCutoff = t - this.rateWindowMs;
    const scanCutoff = t - this.scanWindowMs;

    for (const [ip, state] of this.ips) {
      for (const [endpoint, queue] of state.rateQueues) {
        while (queue.head < queue.ts.length && queue.ts[queue.head]! <= rateCutoff) {
          queue.head += 1;
        }
        if (queue.head === queue.ts.length) {
          state.rateQueues.delete(endpoint);
        } else if (queue.head > 1024 && queue.head * 2 > queue.ts.length) {
          queue.ts = queue.ts.slice(queue.head);
          queue.head = 0;
        }
      }

      while (state.scanHead < state.scanQueue.length) {
        const [lastSeen, endpoint] = state.scanQueue[state.scanHead]!;
        if (lastSeen > scanCutoff) break;
        state.scanHead += 1;
        if (state.lastSeen.get(endpoint) === lastSeen) {
          state.lastSeen.delete(endpoint);
          state.scanCount -= 1;
        }
      }
      if (state.scanHead > 1024 && state.scanHead * 2 > state.scanQueue.length) {
        state.scanQueue = state.scanQueue.slice(state.scanHead);
        state.scanHead = 0;
      }

      if (state.rateQueues.size === 0 && state.lastSeen.size === 0) {
        this.ips.delete(ip);
      }
    }
  }
}

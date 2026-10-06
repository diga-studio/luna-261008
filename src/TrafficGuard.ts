import type { Classification } from "./types";
import { RATE_ABUSE, ENDPOINT_SCAN } from "./types";

/** Window and threshold for RATE_ABUSE: >100 requests per (ip, endpoint) in 60s. */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 100;
/** Window and threshold for ENDPOINT_SCAN: >20 distinct endpoints per ip in 300s. */
const SCAN_WINDOW_MS = 300_000;
const SCAN_LIMIT = 20;

/** Timestamps of requests for one (ip, endpoint) pair, non-decreasing. */
interface PairState {
  times: number[];
  head: number;
}

/** Per-IP endpoint activity: endpoint -> latest request timestamp. */
interface IpState {
  lastSeen: Map<string, number>;
  distinct: number;
}

interface GlobalEvent {
  t: number;
  ip: string;
  endpoint: string;
}

/**
 * In-process real-time traffic classifier.
 *
 * All calls are serial and timestamps are globally non-decreasing.
 * Time advances only via observe()/advance(); no system clock is used.
 *
 * Both windows are left-open, right-closed: a request at exactly
 * t - windowMs is expired, a request at exactly t counts.
 */
export class TrafficGuard {
  private now = 0;
  /** Global FIFO of all live events (last SCAN_WINDOW_MS), used for expiry. */
  private events: GlobalEvent[] = [];
  private eventsHead = 0;
  /** ip -> endpoint -> per-pair request timestamps. */
  private pairs = new Map<string, Map<string, PairState>>();
  /** ip -> endpoint activity for the scan window. */
  private ips = new Map<string, IpState>();

  constructor() {
    // all state initialized as field initializers
  }

  /**
   * Advance time to t, record the request, and return the classifications
   * hit by this request.
   */
  observe(ip: string, endpoint: string, t: number): Classification[] {
    this.advance(t);

    this.events.push({ t, ip, endpoint });

    let inner = this.pairs.get(ip);
    if (inner === undefined) {
      inner = new Map();
      this.pairs.set(ip, inner);
    }
    let pair = inner.get(endpoint);
    if (pair === undefined) {
      pair = { times: [], head: 0 };
      inner.set(endpoint, pair);
    }
    pair.times.push(t);
    // Expire entries outside the left-open rate window: (t - 60000, t].
    const rateCutoff = t - RATE_WINDOW_MS;
    while (pair.head < pair.times.length && pair.times[pair.head]! <= rateCutoff) {
      pair.head++;
    }

    let ipState = this.ips.get(ip);
    if (ipState === undefined) {
      ipState = { lastSeen: new Map(), distinct: 0 };
      this.ips.set(ip, ipState);
    }
    if (!ipState.lastSeen.has(endpoint)) {
      ipState.distinct++;
    }
    ipState.lastSeen.set(endpoint, t);

    const hits: Classification[] = [];
    if (pair.times.length - pair.head > RATE_LIMIT) {
      hits.push(RATE_ABUSE);
    }
    if (ipState.distinct > SCAN_LIMIT) {
      hits.push(ENDPOINT_SCAN);
    }
    return hits;
  }

  /** Advance time to t and expire stale state, without recording a request. */
  advance(t: number): void {
    if (t <= this.now) {
      return;
    }
    this.now = t;
    // Expire events outside the left-open scan window: (t - 300000, t].
    const cutoff = t - SCAN_WINDOW_MS;
    const events = this.events;
    let head = this.eventsHead;
    while (head < events.length && events[head]!.t <= cutoff) {
      this.expireEvent(events[head]!);
      head++;
    }
    this.eventsHead = head;
    // Compact the queue when the consumed prefix dominates.
    if (head > 1024 && head * 2 >= events.length) {
      events.splice(0, head);
      this.eventsHead = 0;
    }
  }

  /** Remove one expired event from the per-pair and per-IP structures. */
  private expireEvent(ev: GlobalEvent): void {
    const inner = this.pairs.get(ev.ip);
    if (inner !== undefined) {
      const pair = inner.get(ev.endpoint);
      if (pair !== undefined) {
        // The rate-window eviction may have already consumed this entry;
        // both evictions pop from the front in timestamp order.
        if (pair.head < pair.times.length && pair.times[pair.head] === ev.t) {
          pair.head++;
        }
        if (pair.head >= pair.times.length) {
          inner.delete(ev.endpoint);
          if (inner.size === 0) {
            this.pairs.delete(ev.ip);
          }
        } else if (pair.head > 1024 && pair.head * 2 >= pair.times.length) {
          pair.times.splice(0, pair.head);
          pair.head = 0;
        }
      }
    }

    const ipState = this.ips.get(ev.ip);
    if (ipState !== undefined && ipState.lastSeen.get(ev.endpoint) === ev.t) {
      // This was the most recent request to the endpoint; the endpoint
      // leaves the scan window. A newer request would have overwritten it.
      ipState.lastSeen.delete(ev.endpoint);
      ipState.distinct--;
      if (ipState.lastSeen.size === 0) {
        this.ips.delete(ev.ip);
      }
    }
  }
}

import type { Classification } from "../src/types";
import { RATE_ABUSE, ENDPOINT_SCAN } from "../src/types";

export interface Event {
  ip: string;
  endpoint: string;
  t: number;
}

/**
 * Brute-force reference: keeps every event and recomputes both windows
 * from scratch for each query. Used to cross-check TrafficGuard.
 */
export class ReferenceGuard {
  private readonly events: Event[] = [];

  observe(ip: string, endpoint: string, t: number): Classification[] {
    this.events.push({ ip, endpoint, t });
    return this.classify(ip, endpoint, t);
  }

  advance(_t: number): void {
    // The reference keeps full history; time advancement changes nothing
    // until the next observe recomputes its windows.
  }

  private classify(ip: string, endpoint: string, t: number): Classification[] {
    const rateCutoff = t - 60_000;
    const scanCutoff = t - 300_000;
    let rateCount = 0;
    const endpoints = new Set<string>();
    for (const ev of this.events) {
      if (ev.ip !== ip) {
        continue;
      }
      if (ev.t > rateCutoff && ev.t <= t && ev.endpoint === endpoint) {
        rateCount++;
      }
      if (ev.t > scanCutoff && ev.t <= t) {
        endpoints.add(ev.endpoint);
      }
    }
    const hits: Classification[] = [];
    if (rateCount > 100) {
      hits.push(RATE_ABUSE);
    }
    if (endpoints.size > 20) {
      hits.push(ENDPOINT_SCAN);
    }
    return hits;
  }
}

import type {
  AuthorityRecord,
  Cache,
  ChangeRecord,
  EntryEvent,
  OfflineDecision,
  ReconcileResult,
  TimeWindow,
  Token,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { buildTimeline, classify, okThroughout } from "./timeline.js";

export * from "./types.js";

export interface AccessTracer {
  ingestAuthority(records: AuthorityRecord[]): void;
  makeCache(): Cache;
  checkOffline(cache: Cache, token: Token, window: TimeWindow): OfflineDecision;
  reconcile(events: EntryEvent[]): ReconcileResult[];
}

interface KnownState {
  /** 从 seq=1 起连续到齐的记录数（缺号之后的记录不参与任何判定） */
  prefixLength: number;
  /** 最新完整封口的时间边界，无封口时为 -Infinity */
  boundary: number;
  /** 最新完整封口的 seq，无封口时为 0 */
  sealSeq: number;
  /** 连续前缀内、seq <= sealSeq 的变更，按身份分组 */
  timelines: Readonly<Record<string, readonly ChangeRecord[]>>;
}

export function createAccessTracer(): AccessTracer {
  // 按 seq 去重存放；重复投递不改变结果
  const bySeq = new Map<number, AuthorityRecord>();

  const knownState = (): KnownState => {
    let prefixLength = 0;
    while (bySeq.has(prefixLength + 1)) prefixLength += 1;
    let sealSeq = 0;
    let boundary = -Infinity;
    for (let seq = 1; seq <= prefixLength; seq += 1) {
      const rec = bySeq.get(seq)!;
      if (rec.kind === "seal") {
        sealSeq = rec.seq;
        boundary = rec.time;
      }
    }
    const grouped = new Map<string, ChangeRecord[]>();
    for (let seq = 1; seq <= sealSeq; seq += 1) {
      const rec = bySeq.get(seq)!;
      if (rec.kind === "change") {
        const list = grouped.get(rec.identity) ?? [];
        list.push(rec);
        grouped.set(rec.identity, list);
      }
    }
    const timelines: Record<string, readonly ChangeRecord[]> = {};
    for (const [identity, list] of grouped) {
      timelines[identity] = Object.freeze(buildTimeline(list));
    }
    return {
      prefixLength,
      boundary,
      sealSeq,
      timelines: Object.freeze(timelines),
    };
  };

  return {
    ingestAuthority(records: AuthorityRecord[]): void {
      for (const rec of records) {
        // 冻结副本，避免调用方事后改写已入库记录
        if (!bySeq.has(rec.seq)) bySeq.set(rec.seq, Object.freeze({ ...rec }));
      }
    },
    makeCache(): Cache {
      const state = knownState();
      return Object.freeze({
        boundary: state.boundary,
        sealSeq: state.sealSeq,
        timelines: state.timelines,
      });
    },
    checkOffline(cache: Cache, token: Token, window: TimeWindow): OfflineDecision {
      const timeline = cache.timelines[token.identity] ?? [];
      const allowed = okThroughout(timeline, token, window);
      const event: EntryEvent = {
        id: randomUUID(),
        token,
        window,
        localAllowed: allowed,
      };
      return { allowed, event };
    },
    reconcile(events: EntryEvent[]): ReconcileResult[] {
      const state = knownState();
      return events.map((event) => {
        if (event.window.end > state.boundary) {
          return { id: event.id, verdict: "pending", anomaly: false };
        }
        const timeline = state.timelines[event.token.identity] ?? [];
        const coverage = classify(timeline, event.token, event.window);
        const verdict =
          coverage === "all" ? "allowed" : coverage === "none" ? "denied" : "uncertain";
        return {
          id: event.id,
          verdict,
          anomaly: event.localAllowed && verdict === "denied",
        };
      });
    },
  };
}

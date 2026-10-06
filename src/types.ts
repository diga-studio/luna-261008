/** Opaque event body bytes supplied by the caller. */
export type EventBody = Uint8Array;

/** A threat event as transmitted from agent side to summary side. */
export interface ThreatEvent {
  /** Per-agent sequence number, contiguous from 1. */
  seq: number;
  /** Stable caller-supplied event identifier. */
  eventId: string;
  /** Opaque original body bytes. */
  body: EventBody;
}

/** Result of a local receive on the agent side. */
export interface ReceiveResult {
  /** Sequence number assigned to this event id (stable across retries). */
  seq: number;
  /** True if this call created the record, false if it was already known. */
  created: boolean;
}

/** A publicly visible summary record (contiguous prefix only). */
export interface SummaryRecord {
  seq: number;
  eventId: string;
  body: EventBody;
}

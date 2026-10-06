/** A single request log record. */
export interface RequestRecord {
  /** Millisecond timestamp of the request. */
  readonly timestampMs: number;
  /** Service name. */
  readonly service: string;
  /** HTTP status code; 500-599 counts as an error. */
  readonly status: number;
  /** Trace id; a trace may span services and contain many requests. */
  readonly traceId: string;
}

/** A half-open millisecond interval [startMs, endMs). */
export interface AnomalyInterval {
  readonly startMs: number;
  readonly endMs: number;
}

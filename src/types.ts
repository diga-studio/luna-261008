/** A single request log record. */
export interface RequestRecord {
  /** Request time in milliseconds since epoch. */
  timestampMs: number;
  /** Service name. */
  service: string;
  /** HTTP status code; 500-599 counts as an error. */
  statusCode: number;
  /** Trace id; one trace may span services and contain many requests. */
  traceId: string;
}

/** A maximal continuous anomalous interval, [startMs, endMs), millisecond precision. */
export interface AnomalyInterval {
  startMs: number;
  endMs: number;
}

/** Sliding window length: 15 minutes in milliseconds. */
export const WINDOW_MS = 900_000;

/**
 * Error-rate threshold: a time point is anomalous when errors/total is
 * strictly greater than 5%, i.e. 20 * errors > total (integer-exact).
 */
export const ERROR_RATE_DENOMINATOR = 20;

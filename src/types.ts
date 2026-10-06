/** A single file-download event. `timestamp` is integer UTC seconds. */
export interface DownloadEvent {
  eventId: string;
  employeeId: string;
  fileId: string;
  timestamp: number;
}

/** Half-open interval [start, end) in UTC seconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Net alert change for one employee caused by a batch:
 * `removed` intervals were deleted, `added` intervals were created.
 */
export interface AlertChange {
  employeeId: string;
  added: Interval[];
  removed: Interval[];
}

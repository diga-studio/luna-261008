/** Latitude/longitude of a zip code centroid, in degrees. */
export interface ZipCoord {
  lat: number;
  lon: number;
}

/**
 * A published, valid job posting.
 * - `id`: unique ASCII string
 * - `zip`: zip code present in the provided zip-code table
 * - `skills`: up to 15 normalized, de-duplicated skill labels
 * - `slots`: non-empty subset of the 14 weekly AM/PM slots (0..13)
 */
export interface Job {
  id: string;
  zip: string;
  skills: string[];
  slots: number[];
}

/**
 * A job seeker.
 * - `id`: unique ASCII string
 * - `zip`: zip code present in the provided zip-code table
 * - `skills`: up to 20 normalized, de-duplicated skill labels
 * - `slots`: subset of the 14 weekly AM/PM slots (0..13)
 * - `maxCommuteMiles`: 5..50 in steps of 5
 */
export interface Candidate {
  id: string;
  zip: string;
  skills: string[];
  slots: number[];
  maxCommuteMiles: number;
}

/** Everything the engine needs, supplied by the caller from local files. */
export interface LoadInput {
  jobs: Job[];
  candidates: Candidate[];
  zipCodes: Record<string, ZipCoord>;
}

/** A job recommended to a candidate. */
export interface JobMatch {
  jobId: string;
  /** Composite score rounded to 6 decimal places. */
  score: number;
}

/** A candidate recommended for a job. */
export interface CandidateMatch {
  candidateId: string;
  /** Composite score rounded to 6 decimal places. */
  score: number;
}

/** A published, valid job posting. */
export interface Job {
  id: string;
  zip: string;
  /** Up to 15 normalized, de-duplicated skill labels. */
  skills: string[];
  /** Non-empty subset of the 14 weekly AM/PM slots (indexes 0..13). */
  timeSlots: number[];
}

/** A job seeker. */
export interface Candidate {
  id: string;
  zip: string;
  /** Up to 20 normalized, de-duplicated skill labels. */
  skills: string[];
  /** Subset of the 14 weekly AM/PM slots (indexes 0..13). */
  timeSlots: number[];
  /** Max commute radius in miles: 5..50 in steps of 5. */
  maxCommuteMiles: number;
}

/** Geographic center of a postal code. */
export interface ZipCoordinate {
  zip: string;
  lat: number;
  lon: number;
}

/** One entry of a recommendation result. */
export interface MatchResult {
  /** ID of the recommended object (job id or candidate id). */
  id: string;
  /** Composite score rounded to 6 decimal places. */
  score: number;
}

/** Input datasets accepted by the matcher. */
export interface TalentBridgeData {
  jobs: Job[];
  candidates: Candidate[];
  zips: ZipCoordinate[];
}

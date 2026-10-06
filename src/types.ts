/** A person or criminal record's SSN: full 9 digits, last 4 only, or absent. */
export type Ssn =
  | { kind: "full"; value: string }
  | { kind: "last4"; value: string }
  | { kind: "none" };

export interface PersonInput {
  id: string;
  nameKey: string;
  dob?: string;
  ssn?: Ssn;
}

export interface CriminalRecordInput {
  id: string;
  nameKey: string;
  dob?: string;
  ssn?: Ssn;
}

export type MatchCategory = "exact" | "partial" | "fuzzy";

export interface RecordMatch {
  recordId: string;
  category: MatchCategory;
}

/** Matches for one employee: every hit record id with its best category. */
export interface EmployeeScreeningResult {
  employeeId: string;
  matches: RecordMatch[];
}

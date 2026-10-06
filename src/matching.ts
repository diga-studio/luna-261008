import type { CriminalRecordInput, MatchCategory, PersonInput } from "./types.js";
import { editDistance } from "./levenshtein.js";
import type { Ssn } from "./types.js";

const FUZZY_MAX_EDITS = 2;

function ssnDigits(ssn: Ssn | undefined): string | null {
  if (!ssn || ssn.kind === "none") return null;
  return ssn.value;
}

/**
 * True when both sides have SSN digits and at least one known
 * corresponding position differs. Missing values never conflict.
 */
function ssnConflicts(a: Ssn | undefined, b: Ssn | undefined): boolean {
  const da = ssnDigits(a);
  const db = ssnDigits(b);
  if (da === null || db === null) return false;
  const len = Math.min(da.length, db.length);
  const tailA = da.slice(da.length - len);
  const tailB = db.slice(db.length - len);
  return tailA !== tailB;
}

function dobConflicts(a?: string, b?: string): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

/**
 * Classify one person/record pair.
 * Returns null when the pair is excluded by an identity conflict
 * or fails every category.
 */
export function classifyPair(
  person: PersonInput,
  record: CriminalRecordInput,
): MatchCategory | null {
  if (dobConflicts(person.dob, record.dob)) return null;
  if (ssnConflicts(person.ssn, record.ssn)) return null;

  if (
    person.ssn?.kind === "full" &&
    record.ssn?.kind === "full" &&
    person.ssn.value === record.ssn.value
  ) {
    return "exact";
  }

  const dobEqual = person.dob !== undefined && person.dob === record.dob;
  if (dobEqual && person.nameKey === record.nameKey) return "partial";
  if (dobEqual && editDistance(person.nameKey, record.nameKey) <= FUZZY_MAX_EDITS) {
    return "fuzzy";
  }

  return null;
}

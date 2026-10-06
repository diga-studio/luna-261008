import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetStore, screenEmployees } from "../src/index.js";
import type {
  CriminalRecordInput,
  EmployeeScreeningResult,
  PersonInput,
  RecordMatch,
  Ssn,
} from "../src/index.js";

const full = (value: string): Ssn => ({ kind: "full", value });
const last4 = (value: string): Ssn => ({ kind: "last4", value });

const DATASET: CriminalRecordInput[] = [
  // R1: strong identity for E1/E5
  { id: "R1", nameKey: "johnsmith", dob: "1980-01-01", ssn: full("123456789") },
  // R2: same name+dob as R1 but no SSN — a distinct record that must be kept
  { id: "R2", nameKey: "johnsmith", dob: "1980-01-01" },
  // R3: one substitution away from "johnsmith"
  { id: "R3", nameKey: "johnsmyth", dob: "1980-01-01" },
  // R4: one deletion away from "johnsmith"
  { id: "R4", nameKey: "jonsmith", dob: "1980-01-01" },
  // R5: dob conflicts with E1
  { id: "R5", nameKey: "johnsmi", dob: "1985-05-05" },
  // R6: last4-only SSN record
  { id: "R6", nameKey: "alicedoe", dob: "1990-03-03", ssn: last4("6789") },
  // R7: full SSN conflicts with E1's
  { id: "R7", nameKey: "johnsmith", dob: "1980-01-01", ssn: full("123456780") },
  // R8: no dob, matchable only via full SSN
  { id: "R8", nameKey: "anything", ssn: full("999887777") },
  // R9: same name as E7 but nothing else — must not match
  { id: "R9", nameKey: "johnsmith" },
];

const EMPLOYEES: PersonInput[] = [
  // E1: hits R1 exact, R2 partial, R3/R4 fuzzy; R5 dob-conflict, R7 ssn-conflict
  { id: "E1", nameKey: "johnsmith", dob: "1980-01-01", ssn: full("123456789") },
  // E2: name is one insert + one delete away (2 edits) -> fuzzy on R1/R2/R7
  { id: "E2", nameKey: "xjohnsmit", dob: "1980-01-01" },
  // E3: last4 SSN equal to R6 but dob missing -> no match at all
  { id: "E3", nameKey: "alicedoe", ssn: last4("6789") },
  // E4: same name+dob as R6, last4 equal -> partial (never exact via last4)
  { id: "E4", nameKey: "alicedoe", dob: "1990-03-03", ssn: last4("6789") },
  // E5: identical to E1 -> R1 hits both employees
  { id: "E5", nameKey: "johnsmith", dob: "1980-01-01", ssn: full("123456789") },
  // E6: no dob, full SSN equal to R8 -> exact despite different name
  { id: "E6", nameKey: "different", ssn: full("999887777") },
  // E7: same name as R9 but no dob/ssn anywhere -> no match
  { id: "E7", nameKey: "johnsmith" },
];

const EXPECTED: Record<string, RecordMatch[]> = {
  E1: [
    { recordId: "R1", category: "exact" },
    { recordId: "R2", category: "partial" },
    { recordId: "R3", category: "fuzzy" },
    { recordId: "R4", category: "fuzzy" },
  ],
  E2: [
    { recordId: "R1", category: "fuzzy" },
    { recordId: "R2", category: "fuzzy" },
    { recordId: "R7", category: "fuzzy" },
  ],
  E3: [],
  E4: [{ recordId: "R6", category: "partial" }],
  E5: [
    { recordId: "R1", category: "exact" },
    { recordId: "R2", category: "partial" },
    { recordId: "R3", category: "fuzzy" },
    { recordId: "R4", category: "fuzzy" },
  ],
  E6: [{ recordId: "R8", category: "exact" }],
  E7: [],
};

function byEmployeeId(results: EmployeeScreeningResult[]): Map<string, RecordMatch[]> {
  return new Map(results.map((r) => [r.employeeId, r.matches]));
}

test("end-to-end: mixed dataset yields exactly the expected hits and categories", () => {
  const dir = mkdtempSync(join(tmpdir(), "screening-"));
  try {
    const store = new DatasetStore(join(dir, "dataset.json"));
    store.importRecords(DATASET);

    const results = byEmployeeId(screenEmployees(store, EMPLOYEES));

    assert.equal(results.size, EMPLOYEES.length);
    for (const employee of EMPLOYEES) {
      assert.deepEqual(results.get(employee.id), EXPECTED[employee.id], employee.id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: import persists to a local file and load reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "screening-"));
  try {
    const file = join(dir, "dataset.json");
    const store = new DatasetStore(file);
    assert.deepEqual(store.load(), []); // no file yet

    store.importRecords(DATASET);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      records: CriminalRecordInput[];
    };
    assert.deepEqual(onDisk.records, DATASET);

    // a fresh store over the same file sees the same dataset
    assert.deepEqual(new DatasetStore(file).load(), DATASET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataset stays fixed during a screening run", () => {
  const dir = mkdtempSync(join(tmpdir(), "screening-"));
  try {
    const store = new DatasetStore(join(dir, "dataset.json"));
    store.importRecords(DATASET);
    const first = screenEmployees(store, EMPLOYEES);
    const second = screenEmployees(store, EMPLOYEES);
    assert.deepEqual(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

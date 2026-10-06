import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, classifyPair } from "../src/index.js";
import type { CriminalRecordInput, PersonInput, Ssn } from "../src/index.js";

const full = (value: string): Ssn => ({ kind: "full", value });
const last4 = (value: string): Ssn => ({ kind: "last4", value });
const none: Ssn = { kind: "none" };

test("editDistance: basics", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", ""), 3);
  assert.equal(editDistance("abc", "adc"), 1); // substitute
  assert.equal(editDistance("abc", "abcd"), 1); // insert
  assert.equal(editDistance("abcd", "acd"), 1); // delete
});

test("editDistance: adjacent transposition is not a single edit", () => {
  assert.equal(editDistance("ab", "ba"), 2);
  assert.equal(editDistance("johnsmith", "johnismth"), 2);
});

test("editDistance: insert plus delete totals two edits", () => {
  assert.equal(editDistance("johnsmith", "xjohnsmit"), 2);
});

function person(overrides: Partial<PersonInput>): PersonInput {
  return { id: "P", nameKey: "johnsmith", ...overrides };
}

function record(overrides: Partial<CriminalRecordInput>): CriminalRecordInput {
  return { id: "R", nameKey: "johnsmith", ...overrides };
}

test("exact: identical full SSN, no other field needed", () => {
  const p = person({ nameKey: "someone", ssn: full("123456789") });
  const r = record({ nameKey: "othername", ssn: full("123456789") });
  assert.equal(classifyPair(p, r), "exact");
});

test("last4 SSN match is never exact", () => {
  const p = person({ dob: "1980-01-01", ssn: last4("6789") });
  const r = record({ dob: "1980-01-01", ssn: last4("6789") });
  assert.equal(classifyPair(p, r), "partial");
});

test("partial: same dob and identical name key", () => {
  const p = person({ dob: "1980-01-01" });
  const r = record({ dob: "1980-01-01" });
  assert.equal(classifyPair(p, r), "partial");
});

test("fuzzy: same dob and name within two edits", () => {
  const p = person({ dob: "1980-01-01", nameKey: "johnsmyth" }); // 1 sub
  const r = record({ dob: "1980-01-01" });
  assert.equal(classifyPair(p, r), "fuzzy");
  const p2 = person({ dob: "1980-01-01", nameKey: "xjohnsmit" }); // ins+del
  assert.equal(classifyPair(p2, r), "fuzzy");
});

test("fuzzy: three edits does not match", () => {
  const p = person({ dob: "1980-01-01", nameKey: "johxyzith" });
  const r = record({ dob: "1980-01-01" });
  assert.equal(classifyPair(p, r), null);
});

test("conflict: different known dobs excludes the pair", () => {
  const p = person({ dob: "1980-01-01", ssn: full("123456789") });
  const r = record({ dob: "1981-02-02", ssn: full("123456789") });
  assert.equal(classifyPair(p, r), null);
});

test("conflict: full vs full SSN differing excludes the pair", () => {
  const p = person({ dob: "1980-01-01", ssn: full("123456789") });
  const r = record({ dob: "1980-01-01", ssn: full("123456780") });
  assert.equal(classifyPair(p, r), null);
});

test("conflict: full vs last4 compares only the known tail", () => {
  const p = person({ dob: "1980-01-01", ssn: full("123456789") });
  const clash = record({ dob: "1980-01-01", ssn: last4("6780") });
  assert.equal(classifyPair(p, clash), null);
  const agree = record({ dob: "1980-01-01", ssn: last4("6789") });
  assert.equal(classifyPair(p, agree), "partial");
});

test("missing values never conflict and never prove equality", () => {
  const p = person({ ssn: none });
  const r = record({ ssn: full("123456789") });
  assert.equal(classifyPair(p, r), null); // no dob on either side

  const pNoDob = person({ dob: undefined });
  const rWithDob = record({ dob: "1980-01-01" });
  assert.equal(classifyPair(pNoDob, rWithDob), null); // same name alone is not enough
});

test("same name key alone does not match", () => {
  const p = person({});
  const r = record({});
  assert.equal(classifyPair(p, r), null);
});

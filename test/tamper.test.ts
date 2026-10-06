import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EvidenceStore } from "../src/index.js";
import { freshDir, makeEvent } from "./helpers.js";

const ALICE = "emp-a1b2c3";
const BOB = "emp-d4e5f6";

function populatedDir(withErase: boolean): string {
  const dir = freshDir();
  const store = new EvidenceStore({ dir });
  store.ingest(ALICE, [makeEvent("2026-01-05T09:00:00Z", "login", "a1")]);
  store.ingest(BOB, [makeEvent("2026-01-05T10:00:00Z", "login", "b1")]);
  store.ingest(ALICE, [makeEvent("2026-01-06T09:00:00Z", "export", "a2")]);
  if (withErase) {
    store.eraseEmployee(ALICE);
  }
  return dir;
}

function readLines(dir: string): string[] {
  return readFileSync(join(dir, "audit.log"), "utf8").split("\n").filter((l) => l.length > 0);
}

function writeLines(dir: string, lines: string[]): void {
  writeFileSync(join(dir, "audit.log"), lines.join("\n") + "\n");
}

for (const withErase of [false, true]) {
  const label = withErase ? " (after erasing one employee)" : "";

  test(`modifying a middle audit item is detected${label}`, () => {
    const dir = populatedDir(withErase);
    const lines = readLines(dir);
    const middle = JSON.parse(lines[1]!);
    // Flip one character inside the committed payload/hash material.
    middle.employeeId = middle.employeeId === ALICE ? BOB : ALICE;
    lines[1] = JSON.stringify(middle);
    writeLines(dir, lines);

    const report = new EvidenceStore({ dir }).inspectAudit();
    assert.equal(report.integrityOk, false);
    assert.match(report.integrityError ?? "", /item 2/);
  });

  test(`deleting a middle audit item is detected${label}`, () => {
    const dir = populatedDir(withErase);
    const lines = readLines(dir);
    lines.splice(1, 1);
    writeLines(dir, lines);

    const report = new EvidenceStore({ dir }).inspectAudit();
    assert.equal(report.integrityOk, false);
    assert.ok(report.integrityError !== null);
  });

  test(`rewriting a middle item payload is detected${label}`, () => {
    const dir = populatedDir(withErase);
    const lines = readLines(dir);
    const middle = JSON.parse(lines[1]!);
    if (middle.payloadCiphertext !== null) {
      middle.payloadCiphertext = middle.payloadCiphertext.slice(0, -4) + "AAAA";
    } else {
      middle.payloadCiphertext = "AAAA";
    }
    lines[1] = JSON.stringify(middle);
    writeLines(dir, lines);

    const report = new EvidenceStore({ dir }).inspectAudit();
    assert.equal(report.integrityOk, false);
  });
}

test("integrity holds on a clean store including erased employee items", () => {
  const dir = populatedDir(true);
  const report = new EvidenceStore({ dir }).inspectAudit();
  assert.equal(report.integrityOk, true, report.integrityError ?? "");
  assert.equal(report.items.length, 4);
  assert.equal(report.items[3]!.type, "erase");
});

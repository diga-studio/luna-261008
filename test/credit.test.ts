import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreditLibrary, DimensionValues, Weights } from "../src/index";

// ---- Independent reference model: rebuilds the exact expected result ----
// from the full operation history after every step, sharing no code with
// the library under test.

interface RefFraction {
  num: bigint;
  den: bigint;
}

function refGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function refFrac(num: bigint, den: bigint = 1n): RefFraction {
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = refGcd(num, den);
  return { num: num / g, den: den / g };
}

function refAdd(a: RefFraction, b: RefFraction): RefFraction {
  return refFrac(a.num * b.den + b.num * a.den, a.den * b.den);
}

function refMul(a: RefFraction, b: RefFraction): RefFraction {
  return refFrac(a.num * b.num, a.den * b.den);
}

function refWeight(w: number): RefFraction {
  const s = String(w);
  const dot = s.indexOf(".");
  const digits = dot === -1 ? "" : s.slice(dot + 1);
  const den = 10n ** BigInt(digits.length);
  return refFrac(BigInt(s.replace(".", "")), den);
}

type Op =
  | { kind: "configure"; weights: Weights }
  | {
      kind: "record";
      subjectId: string;
      ratingId: string;
      values: DimensionValues;
    };

function refCredit(
  ops: Op[],
  subjectId: string
): { score: number; restricted: boolean } {
  let weights: Weights = {};
  const latest = new Map<string, DimensionValues>();
  const ratingSubject = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === "configure") {
      weights = { ...op.weights };
    } else {
      ratingSubject.set(op.ratingId, op.subjectId);
      latest.set(op.ratingId, { ...op.values });
    }
  }
  const effective: DimensionValues[] = [];
  for (const [ratingId, values] of latest) {
    if (
      ratingSubject.get(ratingId) === subjectId &&
      Object.keys(values).length > 0
    ) {
      effective.push(values);
    }
  }
  let numerator = refFrac(0n);
  let denominator = refFrac(0n);
  for (const [label, w] of Object.entries(weights)) {
    let sum = 0n;
    let count = 0n;
    for (const values of effective) {
      if (values[label] !== undefined) {
        sum += BigInt(values[label]);
        count += 1n;
      }
    }
    if (count === 0n) continue;
    const wf = refWeight(w);
    numerator = refAdd(numerator, refMul(wf, refFrac(sum, count)));
    denominator = refAdd(denominator, wf);
  }
  const exact =
    denominator.num === 0n
      ? refFrac(10000n)
      : refFrac(
          numerator.num * denominator.den,
          numerator.den * denominator.num
        );
  const q = exact.num / exact.den;
  const r = exact.num % exact.den;
  const rounded =
    (r < 0n ? -2n * r : 2n * r) >= exact.den
      ? q + (exact.num < 0n ? -1n : 1n)
      : q;
  return {
    score: Number(rounded) / 100,
    restricted: exact.num < 4000n * exact.den,
  };
}

// ---- Scenario 1: step-by-step mutations checked against a full rebuild ----

test("weights, corrections and revocations always match a rebuild from history", () => {
  const lib = new CreditLibrary(":memory:");
  const ops: Op[] = [];
  const subject = "customer-1";

  const check = (step: string) => {
    const expected = refCredit(ops, subject);
    const actual = lib.credit("shop-a", subject);
    assert.deepEqual(actual, expected, `step: ${step}`);
  };

  const configure = (weights: Weights) => {
    lib.configure("shop-a", weights);
    ops.push({ kind: "configure", weights });
  };
  const record = (ratingId: string, values: DimensionValues) => {
    lib.record("shop-a", subject, ratingId, values);
    ops.push({ kind: "record", subjectId: subject, ratingId, values });
  };

  // Two dimensions with different observation counts: r1 has both labels,
  // r2 and r3 only have "quality".
  configure({ quality: 1, service: 1 });
  record("r1", { quality: 8000, service: 5000 });
  record("r2", { quality: 6000 });
  record("r3", { quality: 4000, extra: 9000 }); // "extra" not configured yet
  check("initial ratings, uneven observation counts");

  // Change weights twice in a row.
  configure({ quality: 2, service: 1 });
  check("weights changed to 2:1");
  configure({ quality: 0.5, service: 3 });
  check("weights changed to 0.5:3");

  // Enable the previously unconfigured label: its stored values take effect.
  configure({ quality: 1, service: 1, extra: 4 });
  check("previously unconfigured label enabled");

  // Correction that drops the "service" label from r1: it must stop
  // contributing to the service average.
  record("r1", { quality: 7000 });
  check("correction drops a label");

  // Another correction changing values on r2.
  record("r2", { quality: 3000, extra: 1000 });
  check("correction changes values and adds a label");

  // Revoke a whole rating (appeal won): empty map, old versions stay buried.
  record("r3", {});
  check("rating revoked");

  // Revoke everything, then re-rate one of them.
  record("r1", {});
  record("r2", {});
  check("all ratings revoked");
  record("r1", { service: 6500 });
  check("re-rated after revocation");

  // Remove a label from the configuration entirely.
  configure({ service: 1 });
  check("label removed from configuration");

  // No configured label has observations -> default 100, not restricted.
  configure({ unknown: 5 });
  check("no participating dimension defaults to 100");

  lib.close();
});

test("businesses are isolated from each other", () => {
  const lib = new CreditLibrary(":memory:");
  lib.configure("shop-a", { quality: 1 });
  lib.configure("shop-b", { quality: 1 });
  lib.record("shop-a", "u1", "ra", { quality: 1000 });
  lib.record("shop-b", "u1", "rb", { quality: 9000 });
  assert.deepEqual(lib.credit("shop-a", "u1"), { score: 10, restricted: true });
  assert.deepEqual(lib.credit("shop-b", "u1"), { score: 90, restricted: false });
  lib.configure("shop-b", {});
  assert.deepEqual(lib.credit("shop-b", "u1"), { score: 100, restricted: false });
  assert.deepEqual(lib.credit("shop-a", "u1"), { score: 10, restricted: true });
  lib.close();
});

// ---- Scenario 2: restriction boundary uses the unrounded score ----

test("exact score 39.995 still restricts invitations", () => {
  const lib = new CreditLibrary(":memory:");
  lib.configure("shop", { quality: 1 });
  lib.record("shop", "u", "r1", { quality: 3999 });
  lib.record("shop", "u", "r2", { quality: 4000 });
  const result = lib.credit("shop", "u");
  assert.equal(result.restricted, true);
  assert.equal(result.score, 40); // 39.995 rounds to 40.00 for display
  lib.close();
});

test("exact score 40 does not restrict invitations", () => {
  const lib = new CreditLibrary(":memory:");
  lib.configure("shop", { quality: 1 });
  lib.record("shop", "u", "r1", { quality: 3999 });
  lib.record("shop", "u", "r2", { quality: 4001 });
  const result = lib.credit("shop", "u");
  assert.equal(result.restricted, false);
  assert.equal(result.score, 40);
  lib.close();
});

test("state persists across reopening a file-backed database", () => {
  const dir = mkdtempSync(join(tmpdir(), "credit-scoring-"));
  const dbPath = join(dir, "credit.db");
  try {
    const before = new CreditLibrary(dbPath);
    before.configure("shop", { quality: 2, service: 1 });
    before.record("shop", "u", "r1", { quality: 5000, service: 8000 });
    before.record("shop", "u", "r1", { quality: 5500 });
    before.record("shop", "u", "r2", { service: 2000 });
    const expected = before.credit("shop", "u");
    before.close();

    const after = new CreditLibrary(dbPath);
    assert.deepEqual(after.credit("shop", "u"), expected);
    // Corrections still land on the same logical rating after reopening.
    after.record("shop", "u", "r2", {});
    assert.deepEqual(after.credit("shop", "u"), {
      score: 55,
      restricted: false,
    });
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

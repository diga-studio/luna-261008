import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSemVer, compareSemVer } from "../src/semver.js";
import { InvalidVersionError } from "../src/errors.js";

test("parses major.minor.patch and prerelease", () => {
  const v = parseSemVer("1.2.3-alpha.1");
  assert.equal(v.major, 1);
  assert.equal(v.minor, 2);
  assert.equal(v.patch, 3);
  assert.deepEqual(v.prerelease, ["alpha", 1]);
});

test("numeric prerelease identifiers become numbers", () => {
  assert.deepEqual(parseSemVer("0.0.0-1.2.3").prerelease, [1, 2, 3]);
});

test("rejects invalid versions", () => {
  for (const bad of ["1.0", "1.0.0.0", "01.2.3", "1.0.0-", "1.0.0-alpha..1", ""]) {
    assert.throws(() => parseSemVer(bad), InvalidVersionError);
  }
});

test("semver.org precedence chain", () => {
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ].map(parseSemVer);
  for (let i = 0; i < chain.length - 1; i++) {
    assert.equal(compareSemVer(chain[i]!, chain[i + 1]!), -1, `index ${i}`);
    assert.equal(compareSemVer(chain[i + 1]!, chain[i]!), 1, `index ${i} reversed`);
  }
});

test("numeric ordering is not string ordering", () => {
  assert.ok(compareSemVer(parseSemVer("2.0.0"), parseSemVer("10.0.0")) < 0);
  assert.ok(compareSemVer(parseSemVer("1.9.0"), parseSemVer("1.10.0")) < 0);
});

test("build metadata is ignored for precedence", () => {
  assert.equal(
    compareSemVer(parseSemVer("1.0.0+build.1"), parseSemVer("1.0.0+build.2")),
    0,
  );
  assert.equal(compareSemVer(parseSemVer("1.0.0+x"), parseSemVer("1.0.0")), 0);
});

test("numeric identifiers compare lower than alphanumeric", () => {
  assert.ok(compareSemVer(parseSemVer("1.0.0-1"), parseSemVer("1.0.0-a")) < 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planScan } from "../src/index.js";
import { makeSandbox, dir, file, symlink } from "./helpers.js";

test("whitelist excludes exact path and descendants, respects component boundaries", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "work", "safe", "sub"));
    dir(join(sb.root, "work", "safety"));
    file(join(sb.root, "work", "safe", "secret.txt"));
    file(join(sb.root, "work", "safe", "sub", "deep.txt"));
    file(join(sb.root, "work", "safety", "ok.txt"));
    file(join(sb.root, "work", "safe.txt"));
    file(join(sb.root, "work", "plain.txt"));

    const manifest = planScan({
      roots: [join(sb.root, "work")],
      whitelist: [join(sb.root, "work", "safe")],
    });
    const paths = manifest.files.map((f) => f.path);
    assert.deepEqual(paths, [
      join(sb.root, "work", "plain.txt"),
      join(sb.root, "work", "safe.txt"),
      join(sb.root, "work", "safety", "ok.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("whitelisted scan root contributes nothing", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "a"));
    dir(join(sb.root, "b"));
    file(join(sb.root, "a", "fa.txt"));
    file(join(sb.root, "b", "fb.txt"));

    const manifest = planScan({
      roots: [join(sb.root, "a"), join(sb.root, "b")],
      whitelist: [join(sb.root, "a")],
    });
    assert.deepEqual(manifest.files.map((f) => f.path), [join(sb.root, "b", "fb.txt")]);
  } finally {
    sb.cleanup();
  }
});

test("whitelist applies to access paths, not underlying entities", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "target"));
    file(join(sb.root, "target", "f.txt"));
    dir(join(sb.root, "r"));
    symlink(join(sb.root, "target"), join(sb.root, "r", "blocked"));
    symlink(join(sb.root, "target"), join(sb.root, "r", "open"));

    const manifest = planScan({
      roots: [join(sb.root, "r")],
      whitelist: [join(sb.root, "r", "blocked")],
    });
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "r", "open", "f.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("file reachable only by repeating a directory to dodge a whitelist entry", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "d"));
    file(join(sb.root, "d", "f.txt"));
    dir(join(sb.root, "r", "a"));
    // /r/a/x points back to /r/a itself; /r/a/y leads to /d.
    symlink(join(sb.root, "r", "a"), join(sb.root, "r", "a", "x"));
    symlink(join(sb.root, "d"), join(sb.root, "r", "a", "y"));

    const manifest = planScan({
      roots: [join(sb.root, "r")],
      whitelist: [join(sb.root, "r", "a", "y")],
    });
    // /r/a/y/f.txt is excluded, but /r/a/x/y/f.txt is a legal route.
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "r", "a", "x", "y", "f.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("plan limits are enforced", () => {
  assert.throws(
    () => planScan({ roots: Array.from({ length: 21 }, (_, i) => `/r${i}`), whitelist: [] }),
    RangeError,
  );
  assert.throws(
    () => planScan({ roots: [], whitelist: Array.from({ length: 201 }, (_, i) => `/w${i}`) }),
    RangeError,
  );
});

test("file sitting on a whitelist prefix path is still listed", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "r", "a"));
    file(join(sb.root, "r", "a", "b")); // a proper prefix of the whitelist entry
    file(join(sb.root, "r", "a", "c.txt"));

    const manifest = planScan({
      roots: [join(sb.root, "r")],
      whitelist: [join(sb.root, "r", "a", "b", "deep", "deeper")],
    });
    // /r/a/b itself is legal (only its descendants would be excluded, and
    // being a file it has none).
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "r", "a", "b"),
      join(sb.root, "r", "a", "c.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("whitelist entries with 32 components are honored", () => {
  const sb = makeSandbox();
  try {
    const deep = Array.from({ length: 32 }, (_, i) => `w${i}`);
    const deepDir = join(sb.root, "r", ...deep.slice(0, -1));
    dir(deepDir);
    file(join(sb.root, "r", ...deep)); // the whitelisted file itself
    file(join(deepDir, "sibling.txt"));

    const manifest = planScan({
      roots: [join(sb.root, "r")],
      whitelist: [join(sb.root, "r", ...deep)],
    });
    assert.deepEqual(manifest.files.map((f) => f.path), [join(deepDir, "sibling.txt")]);
  } finally {
    sb.cleanup();
  }
});

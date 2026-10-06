import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planScan } from "../src/index.js";
import { makeSandbox, dir, file, symlink, hardlink } from "./helpers.js";

test("overlapping roots and hard links yield one record per entity", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "ra", "sub"));
    file(join(sb.root, "ra", "sub", "f.txt"));
    dir(join(sb.root, "rb", "sub"));
    hardlink(join(sb.root, "ra", "sub", "f.txt"), join(sb.root, "rb", "sub", "g.txt"));

    const manifest = planScan({
      roots: [join(sb.root, "ra"), join(sb.root, "ra", "sub"), join(sb.root, "rb")],
      whitelist: [],
    });
    // Entity reachable via /ra/sub/f.txt (three times, identical strings) and
    // /rb/sub/g.txt: same component count, byte order picks "/ra/sub/f.txt".
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, join(sb.root, "ra", "sub", "f.txt"));
  } finally {
    sb.cleanup();
  }
});

test("symlinked directories and files resolve to the same entity", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "real", "inner"));
    file(join(sb.root, "real", "inner", "doc.txt"));
    dir(join(sb.root, "r"));
    symlink(join(sb.root, "real"), join(sb.root, "r", "dirlink"));
    symlink(join(sb.root, "real", "inner", "doc.txt"), join(sb.root, "r", "filelink.txt"));

    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    // /r/dirlink/inner/doc.txt (4 components below root) vs /r/filelink.txt
    // (2 below root): fewer components wins.
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, join(sb.root, "r", "filelink.txt"));
  } finally {
    sb.cleanup();
  }
});

test("independent files with identical content are listed separately", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "r"));
    file(join(sb.root, "r", "a.txt"), "same-content");
    file(join(sb.root, "r", "b.txt"), "same-content");

    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "r", "a.txt"),
      join(sb.root, "r", "b.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("dangling links and non-regular files contribute nothing", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "r"));
    file(join(sb.root, "r", "real.txt"));
    symlink(join(sb.root, "r", "missing.txt"), join(sb.root, "r", "dangling.txt"));
    symlink(join(sb.root, "r"), join(sb.root, "r", "selfloop"));

    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    assert.deepEqual(manifest.files.map((f) => f.path), [join(sb.root, "r", "real.txt")]);
  } finally {
    sb.cleanup();
  }
});

test("representative path: fewest components, then UTF-8 byte order", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "deep", "x", "y"));
    file(join(sb.root, "deep", "x", "y", "f.txt"));
    dir(join(sb.root, "zeta"));
    dir(join(sb.root, "alpha"));
    // Two shallow aliases to the same deep directory.
    symlink(join(sb.root, "deep", "x", "y"), join(sb.root, "zeta", "alias"));
    symlink(join(sb.root, "deep", "x", "y"), join(sb.root, "alpha", "alias"));

    const manifest = planScan({
      roots: [join(sb.root, "deep"), join(sb.root, "zeta"), join(sb.root, "alpha")],
      whitelist: [],
    });
    assert.equal(manifest.files.length, 1);
    // Candidates: /deep/x/y/f.txt (5), /zeta/alias/f.txt (4),
    // /alpha/alias/f.txt (4). Byte order: alpha < zeta.
    assert.equal(manifest.files[0].path, join(sb.root, "alpha", "alias", "f.txt"));
  } finally {
    sb.cleanup();
  }
});

test("byte-order tie-break compares full path bytes, not component-wise prefixes", () => {
  const sb = makeSandbox();
  try {
    // "b" is a string prefix of "b!c"; plain prefix comparison would rank
    // ".../b/..." below ".../b!c/...", but full-path byte order puts the
    // separator 0x2F above "!" (0x21), so "/b!c/..." is smaller.
    dir(join(sb.root, "b"));
    dir(join(sb.root, "b!c"));
    file(join(sb.root, "b", "shared.txt"));
    hardlink(join(sb.root, "b", "shared.txt"), join(sb.root, "b!c", "shared.txt"));

    const manifest = planScan({ roots: [sb.root], whitelist: [] });
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, join(sb.root, "b!c", "shared.txt"));
  } finally {
    sb.cleanup();
  }
});

test("prefix-anomalous aliases to one directory pick the byte-smallest full path", () => {
  const sb = makeSandbox();
  try {
    const root = join(sb.root, "scan");
    dir(join(sb.root, "hidden", "real"));
    file(join(sb.root, "hidden", "real", "x.txt"));
    dir(join(root, "a"));
    // "b" is a string prefix of "b!c"; naive prefix comparison prefers "b",
    // but full-path byte order compares "/" (0x2F) against "!" (0x21) and
    // prefers "b!c" for any suffix.
    symlink(join(sb.root, "hidden", "real"), join(root, "a", "b"));
    symlink(join(sb.root, "hidden", "real"), join(root, "a", "b!c"));

    const manifest = planScan({ roots: [root], whitelist: [] });
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, join(root, "a", "b!c", "x.txt"));
  } finally {
    sb.cleanup();
  }
});

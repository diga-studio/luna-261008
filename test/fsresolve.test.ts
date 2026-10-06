import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planScan } from "../src/index.js";
import { makeSandbox, dir, file, symlink } from "./helpers.js";

test("relative symlink targets and dot segments are resolved", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "base", "sub"));
    file(join(sb.root, "base", "sub", "f.txt"));
    dir(join(sb.root, "r"));
    // Relative target with ".." that must be resolved against the link's dir.
    symlink("../base", join(sb.root, "r", "rel"));
    symlink("./rel/sub", join(sb.root, "r", "dotseg"));

    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    assert.equal(manifest.files.length, 1);
    // /r/dotseg/f.txt and /r/rel/sub/f.txt tie at 4 components below root;
    // "dotseg" < "rel" bytewise.
    assert.equal(manifest.files[0].path, join(sb.root, "r", "dotseg", "f.txt"));
  } finally {
    sb.cleanup();
  }
});

test("symlink loops contribute nothing and do not hang", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "r"));
    file(join(sb.root, "r", "real.txt"));
    symlink("loopb", join(sb.root, "r", "loopa"));
    symlink("loopa", join(sb.root, "r", "loopb"));
    symlink(".", join(sb.root, "r", "selfdot"));

    const start = performance.now();
    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    const elapsedMs = performance.now() - start;
    assert.deepEqual(manifest.files.map((f) => f.path), [join(sb.root, "r", "real.txt")]);
    assert.ok(elapsedMs < 5_000, `took ${elapsedMs}ms`);
  } finally {
    sb.cleanup();
  }
});

test("deep symlink chains beyond the kernel nesting limit still resolve", () => {
  const sb = makeSandbox();
  try {
    // 60 chained symlinks: far beyond the kernel's per-lookup limit (32/40).
    const chainDir = join(sb.root, "chain");
    dir(chainDir);
    file(join(sb.root, "target.txt"));
    symlink(join(sb.root, "target.txt"), join(chainDir, "l0"));
    for (let i = 1; i < 60; i++) {
      symlink(join(chainDir, `l${i - 1}`), join(chainDir, `l${i}`));
    }
    dir(join(sb.root, "r"));
    symlink(join(chainDir, "l59"), join(sb.root, "r", "deep.txt"));

    const manifest = planScan({ roots: [join(sb.root, "r")], whitelist: [] });
    assert.deepEqual(manifest.files.map((f) => f.path), [join(sb.root, "r", "deep.txt")]);
  } finally {
    sb.cleanup();
  }
});

test("whitelisted shorter route does not become the representative path", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "real"));
    file(join(sb.root, "real", "f.txt"));
    dir(join(sb.root, "r", "sub"));
    symlink(join(sb.root, "real"), join(sb.root, "r", "short"));
    symlink(join(sb.root, "real"), join(sb.root, "r", "sub", "long"));

    const manifest = planScan({
      roots: [join(sb.root, "r")],
      whitelist: [join(sb.root, "r", "short")],
    });
    // The 3-component route is whitelisted; the 4-component route is legal.
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "r", "sub", "long", "f.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

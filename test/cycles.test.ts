import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planScan } from "../src/index.js";
import { makeSandbox, dir, file, symlink } from "./helpers.js";

test("directory link cycles terminate and keep every reachable file once", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "c", "inner"));
    file(join(sb.root, "c", "top.txt"));
    file(join(sb.root, "c", "inner", "deep.txt"));
    symlink(join(sb.root, "c"), join(sb.root, "c", "inner", "up"));
    symlink(join(sb.root, "c", "inner"), join(sb.root, "c", "back"));

    const manifest = planScan({ roots: [join(sb.root, "c")], whitelist: [] });
    // deep.txt is reachable via /c/inner and /c/back (a symlink to inner);
    // equal component counts, and "back" sorts before "inner" bytewise.
    assert.deepEqual(manifest.files.map((f) => f.path), [
      join(sb.root, "c", "back", "deep.txt"),
      join(sb.root, "c", "top.txt"),
    ]);
  } finally {
    sb.cleanup();
  }
});

test("28-level double-branch convergence: 2^28 access routes, constant work", () => {
  const sb = makeSandbox();
  try {
    const root = join(sb.root, "dia");
    dir(root);
    const levels: string[] = [root];
    for (let i = 0; i <= 28; i++) {
      if (i === 0) continue;
      // Real level directories live outside the scan root; they are only
      // reachable through the symlink chain.
      const p = join(sb.root, "hidden", `l${i}`);
      dir(p);
      levels.push(p);
    }
    for (let i = 0; i < 28; i++) {
      symlink(levels[i + 1], join(levels[i], "p"));
      symlink(levels[i + 1], join(levels[i], "q"));
    }
    file(join(levels[28], "leaf.txt"));
    file(join(levels[14], "mid.txt"));
    symlink(levels[0], join(levels[28], "loop")); // cycle back to the top

    const start = performance.now();
    const manifest = planScan({ roots: [levels[0]], whitelist: [] });
    const elapsedMs = performance.now() - start;

    // 2^28 routes to leaf.txt and 2^14 routes to mid.txt, but only two
    // underlying file entities; cost must not scale with route count.
    assert.equal(manifest.files.length, 2);
    const byDepth = [...manifest.files].sort((a, b) => a.path.length - b.path.length);
    assert.equal(
      byDepth[0].path,
      join(levels[0], ...Array(14).fill("p"), "mid.txt"),
    );
    assert.equal(
      byDepth[1].path,
      join(levels[0], ...Array(28).fill("p"), "leaf.txt"),
    );
    assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms`);
  } finally {
    sb.cleanup();
  }
});

test("broad tree with 10k files scans well within the time budget", () => {
  const sb = makeSandbox();
  try {
    const root = join(sb.root, "broad");
    for (let d = 0; d < 100; d++) {
      const p = join(root, `d${String(d).padStart(3, "0")}`);
      dir(p);
      for (let f = 0; f < 100; f++) {
        file(join(p, `f${String(f).padStart(3, "0")}.txt`));
      }
    }

    const start = performance.now();
    const manifest = planScan({ roots: [root], whitelist: [] });
    const elapsedMs = performance.now() - start;

    assert.equal(manifest.files.length, 10_000);
    assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms`);
  } finally {
    sb.cleanup();
  }
});

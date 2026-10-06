import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planScan } from "../src/index.js";
import { makeSandbox, dir, file, symlink, hardlink } from "./helpers.js";

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

test("entity set and representative paths are independent of root order", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "r1", "shared", "sub"));
    file(join(sb.root, "r1", "shared", "sub", "a.txt"));
    file(join(sb.root, "r1", "shared", "b.txt"));
    file(join(sb.root, "r1", "only1.txt"));
    dir(join(sb.root, "r2"));
    file(join(sb.root, "r2", "only2.txt"));
    hardlink(join(sb.root, "r1", "shared", "b.txt"), join(sb.root, "r2", "blink.txt"));
    dir(join(sb.root, "r3"));
    symlink(join(sb.root, "r1", "shared"), join(sb.root, "r3", "slink"));
    file(join(sb.root, "r3", "only3.txt"));

    const roots = [join(sb.root, "r1"), join(sb.root, "r2"), join(sb.root, "r3")];
    const whitelist = [join(sb.root, "r1", "shared", "sub")];

    const baseline = planScan({ roots, whitelist });
    // Sanity: the whitelisted /r1/shared/sub/a.txt still enters via /r3/slink.
    assert.ok(baseline.files.some((f) => f.path === join(sb.root, "r3", "slink", "sub", "a.txt")));
    assert.equal(baseline.files.length, 5);

    for (const perm of permutations(roots)) {
      const manifest = planScan({ roots: perm, whitelist });
      assert.deepEqual(manifest, baseline, `order ${perm.join(",")}`);
    }
  } finally {
    sb.cleanup();
  }
});

test("overlapping roots in any order give identical manifests", () => {
  const sb = makeSandbox();
  try {
    dir(join(sb.root, "o", "sub", "deep"));
    file(join(sb.root, "o", "top.txt"));
    file(join(sb.root, "o", "sub", "mid.txt"));
    file(join(sb.root, "o", "sub", "deep", "leaf.txt"));

    const roots = [join(sb.root, "o"), join(sb.root, "o", "sub"), join(sb.root, "o", "sub", "deep")];
    const baseline = planScan({ roots, whitelist: [] });
    assert.equal(baseline.files.length, 3);
    for (const perm of permutations(roots)) {
      assert.deepEqual(planScan({ roots: perm, whitelist: [] }), baseline);
    }
  } finally {
    sb.cleanup();
  }
});

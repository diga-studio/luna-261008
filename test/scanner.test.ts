import { test } from "node:test";
import assert from "node:assert/strict";
import { planScan } from "../src/index";
import type { ScanManifest } from "../src/index";
import { Fixture } from "./helpers";

function paths(manifest: ScanManifest): string[] {
  return manifest.files.map((entry) => entry.path);
}

test("overlapping roots and hard links yield each entity exactly once", () => {
  const fixture = new Fixture();
  try {
    fixture.file("a/x.txt", "shared");
    fixture.hardLink("a/x.txt", "b/y.txt");
    fixture.file("a/solo.txt", "solo");
    // Overlapping roots: root and its own subdirectory, plus the link dir.
    const manifest = planScan({
      roots: [fixture.path("a"), fixture.path("b"), fixture.path("a")],
      whitelist: [],
    });
    // Entities: x.txt (== y.txt) and solo.txt => 2 entries.
    assert.equal(manifest.files.length, 2);
    // Representative: fewest components, then UTF-8 byte order.
    // x.txt entity candidates: <a>/x.txt and <b>/y.txt (both depth 3);
    // byte order picks the smaller absolute path.
    const expected = [fixture.path("a/x.txt"), fixture.path("b/y.txt")].sort();
    assert.deepEqual(paths(manifest), [expected[0], fixture.path("a/solo.txt")].sort());
    const entry = manifest.files.find((item) => item.path === expected[0]);
    assert.ok(entry);
    assert.equal(typeof entry.dev, "bigint");
    assert.equal(typeof entry.ino, "bigint");
  } finally {
    fixture.cleanup();
  }
});

test("identical content but independent files are listed separately", () => {
  const fixture = new Fixture();
  try {
    fixture.file("p/one.txt", "same-bytes");
    fixture.file("q/two.txt", "same-bytes");
    const manifest = planScan({ roots: [fixture.root], whitelist: [] });
    assert.deepEqual(paths(manifest), [
      fixture.path("p/one.txt"),
      fixture.path("q/two.txt"),
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("whitelist excludes exact path and descendants on component boundaries", () => {
  const fixture = new Fixture();
  try {
    fixture.file("safe/inner.txt");
    fixture.file("safety/inner.txt");
    fixture.file("safekeep.txt");
    const manifest = planScan({
      roots: [fixture.root],
      whitelist: [fixture.path("safe")],
    });
    assert.deepEqual(paths(manifest), [
      fixture.path("safekeep.txt"),
      fixture.path("safety/inner.txt"),
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("whitelisting a directory excludes its whole subtree", () => {
  const fixture = new Fixture();
  try {
    fixture.file("w/sub/deep.txt");
    fixture.file("w/top.txt");
    fixture.file("keep.txt");
    const manifest = planScan({
      roots: [fixture.root],
      whitelist: [fixture.path("w")],
    });
    assert.deepEqual(paths(manifest), [fixture.path("keep.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("whitelisted scan root contributes nothing, other roots still do", () => {
  const fixture = new Fixture();
  try {
    fixture.file("w/hidden.txt");
    fixture.file("real/shown.txt");
    const manifest = planScan({
      roots: [fixture.path("w"), fixture.path("real")],
      whitelist: [fixture.path("w")],
    });
    assert.deepEqual(paths(manifest), [fixture.path("real/shown.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("entity reachable via whitelisted path still enters via a legal path", () => {
  const fixture = new Fixture();
  try {
    fixture.file("real/f.txt");
    fixture.symlink(fixture.path("real"), "alias");
    // Whitelisting the alias must not hide the entity reached directly.
    const manifest = planScan({
      roots: [fixture.root],
      whitelist: [fixture.path("alias")],
    });
    assert.deepEqual(paths(manifest), [fixture.path("real/f.txt")]);
    // And vice versa: whitelisting the real directory leaves the alias route.
    const manifest2 = planScan({
      roots: [fixture.root],
      whitelist: [fixture.path("real")],
    });
    assert.deepEqual(paths(manifest2), [fixture.path("alias/f.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("representative path keeps access names and minimizes components", () => {
  const fixture = new Fixture();
  try {
    fixture.file("very/deep/dir/f.txt");
    fixture.symlink(fixture.path("very/deep/dir"), "short");
    const manifest = planScan({ roots: [fixture.root], whitelist: [] });
    // The symlink route has fewer components and keeps the link's name.
    assert.deepEqual(paths(manifest), [fixture.path("short/f.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("ties in component count are broken by UTF-8 byte order", () => {
  const fixture = new Fixture();
  try {
    fixture.file("target/f.txt");
    fixture.symlink(fixture.path("target"), "s2");
    fixture.symlink(fixture.path("target"), "s1");
    const manifest = planScan({ roots: [fixture.root], whitelist: [] });
    const candidates = [
      fixture.path("s1/f.txt"),
      fixture.path("s2/f.txt"),
      fixture.path("target/f.txt"),
    ].sort();
    assert.deepEqual(paths(manifest), [candidates[0]]);
  } finally {
    fixture.cleanup();
  }
});

test("symlinks pointing outside every scan root are followed", () => {
  const fixture = new Fixture();
  try {
    fixture.file("outside/f.txt");
    fixture.dir("inside");
    fixture.symlink(fixture.path("outside"), "inside/link");
    const manifest = planScan({ roots: [fixture.path("inside")], whitelist: [] });
    assert.deepEqual(paths(manifest), [fixture.path("inside/link/f.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("dangling symlinks contribute nothing", () => {
  const fixture = new Fixture();
  try {
    fixture.file("real.txt");
    fixture.symlink(fixture.path("missing-target"), "dangling");
    fixture.symlink(fixture.path("missing-dir"), "dir-link");
    const manifest = planScan({ roots: [fixture.root], whitelist: [] });
    assert.deepEqual(paths(manifest), [fixture.path("real.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("link cycles terminate and each entity is listed once", () => {
  const fixture = new Fixture();
  try {
    fixture.file("c/f.txt");
    fixture.symlink(fixture.path("c"), "c/self");
    fixture.dir("d");
    fixture.symlink(fixture.path("d"), "c/to-d");
    fixture.symlink(fixture.path("c"), "d/to-c");
    const manifest = planScan({ roots: [fixture.root], whitelist: [] });
    assert.deepEqual(paths(manifest), [fixture.path("c/f.txt")]);
  } finally {
    fixture.cleanup();
  }
});

test("28-level double-branch convergence stays fast and exact", () => {
  const fixture = new Fixture();
  try {
    const levels = 28;
    fixture.dir("d0");
    for (let i = 0; i < levels; i += 1) {
      fixture.dir(`d${i + 1}`);
      // Two links per level, both pointing at the next level directory.
      fixture.symlink(fixture.path(`d${i + 1}`), `d${i}/a`);
      fixture.symlink(fixture.path(`d${i + 1}`), `d${i}/b`);
    }
    fixture.file(`d${levels}/leaf.txt`);
    // A cycle back to the top, for good measure.
    fixture.symlink(fixture.path("d0"), `d${levels}/back`);
    const started = Date.now();
    const manifest = planScan({ roots: [fixture.path("d0")], whitelist: [] });
    const elapsedMs = Date.now() - started;
    // 2^28 access routes collapse into one entity with one best path.
    const best = `${fixture.path("d0")}/${"a/".repeat(levels)}leaf.txt`;
    assert.deepEqual(paths(manifest), [best]);
    assert.ok(elapsedMs < 20_000, `took ${elapsedMs}ms`);
  } finally {
    fixture.cleanup();
  }
});

test("manifest is independent of scan root order", () => {
  const fixture = new Fixture();
  try {
    fixture.file("r1/shared/a.txt");
    fixture.file("r2/shared/b.txt");
    fixture.symlink(fixture.path("r1/shared"), "r2/alias");
    fixture.hardLink("r1/shared/a.txt", "r2/shared/a-copy.txt");
    const roots = [
      fixture.path("r1"),
      fixture.path("r2"),
      fixture.path("r2/shared"),
      fixture.path("r1/shared"),
    ];
    const baseline = planScan({ roots, whitelist: [] });
    const reversed = planScan({ roots: [...roots].reverse(), whitelist: [] });
    const shuffled = planScan({
      roots: [roots[2]!, roots[0]!, roots[3]!, roots[1]!],
      whitelist: [],
    });
    assert.deepEqual(reversed, baseline);
    assert.deepEqual(shuffled, baseline);
    // Entities: a.txt (== a-copy.txt) and b.txt => exactly 2 entries.
    assert.equal(baseline.files.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("input limits are enforced", () => {
  const roots = Array.from({ length: 21 }, (_, i) => `/r${i}`);
  assert.throws(() => planScan({ roots, whitelist: [] }), RangeError);
  const whitelist = Array.from({ length: 201 }, (_, i) => `/w${i}`);
  assert.throws(() => planScan({ roots: ["/"], whitelist }), RangeError);
});

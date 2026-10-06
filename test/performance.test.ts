import { test } from "node:test";
import assert from "node:assert/strict";
import { planScan } from "../src/index";
import { Fixture } from "./helpers";

const MIB = 1024 * 1024;

test("100k directory entries with deep whitelist meet time and memory limits", { timeout: 60_000 }, () => {
  const fixture = new Fixture();
  try {
    // 100 directories x 200 files = 20_000 real files; each file also
    // reachable through 4 hard links => 100_000 directory entries total.
    const dirCount = 100;
    const filesPerDir = 200;
    for (let d = 0; d < dirCount; d += 1) {
      fixture.dir(`data/dir${d}`);
    }
    for (let d = 0; d < dirCount; d += 1) {
      for (let f = 0; f < filesPerDir; f += 1) {
        fixture.file(`data/dir${d}/f${f}.txt`, `content-${d}-${f}`);
      }
    }
    for (let d = 0; d < dirCount; d += 1) {
      for (let f = 0; f < filesPerDir; f += 1) {
        for (let alias = 0; alias < 3; alias += 1) {
          fixture.hardLink(
            `data/dir${d}/f${f}.txt`,
            `links/${alias}/dir${d}/f${f}.txt`,
          );
        }
      }
    }
    // 200 whitelist entries, each with 32 components.
    const whitelist: string[] = [];
    for (let w = 0; w < 200; w += 1) {
      const components = Array.from({ length: 31 }, (_, i) => `w${w}c${i}`);
      whitelist.push(fixture.path(["nope", ...components, "leaf"].join("/")));
    }
    // A 28-level double-branch convergence on top (>2e8 access routes).
    const levels = 28;
    fixture.dir("conv/d0");
    for (let i = 0; i < levels; i += 1) {
      fixture.dir(`conv/d${i + 1}`);
      fixture.symlink(fixture.path(`conv/d${i + 1}`), `conv/d${i}/a`);
      fixture.symlink(fixture.path(`conv/d${i + 1}`), `conv/d${i}/b`);
    }
    fixture.file(`conv/d${levels}/leaf.txt`);
    fixture.symlink(fixture.path("conv/d0"), `conv/d${levels}/back`);

    const before = process.memoryUsage().rss;
    const started = Date.now();
    const manifest = planScan({
      roots: [fixture.path("data"), fixture.path("links"), fixture.path("conv")],
      whitelist,
    });
    const elapsedMs = Date.now() - started;
    const peakRss = process.memoryUsage().rss;

    // 20_000 entities via data/ and links/, plus the convergence leaf.
    assert.equal(manifest.files.length, dirCount * filesPerDir + 1);
    // Representative paths prefer the shallowest route: data/... (depth 4)
    // beats links/<alias>/... (depth 5), and the convergence leaf is
    // reached directly through conv/d28 instead of the 28-level chain.
    const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
    assert.ok(byPath.has(fixture.path("data/dir0/f0.txt")));
    assert.ok(!byPath.has(fixture.path("links/0/dir0/f0.txt")));
    assert.ok(byPath.has(fixture.path("conv/d28/leaf.txt")));

    assert.ok(elapsedMs < 20_000, `took ${elapsedMs}ms`);
    assert.ok(
      peakRss < 256 * MIB,
      `peak rss ${(peakRss / MIB).toFixed(1)} MiB (delta ${((peakRss - before) / MIB).toFixed(1)} MiB)`,
    );
  } finally {
    fixture.cleanup();
  }
});

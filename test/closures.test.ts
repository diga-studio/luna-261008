import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackage } from "../src/index.ts";
import { extractHtmlRefs, decodeHtmlEntities } from "../src/htmlRefs.ts";
import { isExternalUrl, resolveLocalUrl } from "../src/urlResolve.ts";
import { makeSourceDir } from "./helpers.ts";

// a/page.html and b/page.html are byte-identical but live in different
// directories, so their dependencies resolve differently.
const SHARED_PAGE = [
  "<html><body>",
  '<img src="local.png">',
  '<a href="../shared/end.html">end</a>',
  '<a href="loop.html">loop</a>',
  "</body></html>",
].join("\n");

const FIXTURE: Record<string, string | Buffer> = {
  "a/page.html": SHARED_PAGE,
  "b/page.html": SHARED_PAGE,
  // Circular references back to the entry.
  "a/loop.html": '<html><body><a href="page.html">back</a></body></html>',
  "b/loop.html": '<html><body><a href="page.html">back</a></body></html>',
  "a/local.png": Buffer.from([0xaa, 0x01]),
  "b/local.png": Buffer.from([0xbb, 0x02]),
  // Media shared by both SCOs.
  "shared/end.html": '<html><body><img src="media.png"></body></html>',
  "shared/media.png": Buffer.from([0xcc, 0x03]),
  // Unreachable files that must not be packed.
  "unused/dead.html": '<html><body><a href="../a/page.html">x</a></body></html>',
  "junk.bin": Buffer.from([0x00, 0x01]),
};

const SNAPSHOT = {
  title: "闭包测试",
  modules: [
    { title: "A", entry: "a/page.html" },
    { title: "B", entry: "b/page.html" },
  ],
};

/** Closure computed independently of src/graph.ts (own traversal). */
function independentClosure(dir: string, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!/\.(html|htm)$/i.test(current)) continue;
    const html = readFileSync(join(dir, ...current.split("/")), "utf8");
    for (const ref of extractHtmlRefs(html)) {
      const decoded = decodeHtmlEntities(ref.rawValue);
      if (isExternalUrl(decoded)) continue;
      stack.push(resolveLocalUrl(decoded, current).sourcePath);
    }
  }
  return seen;
}

const EXPECTED_CLOSURES: Record<string, string[]> = {
  "a/page.html": ["a/page.html", "a/local.png", "a/loop.html", "shared/end.html", "shared/media.png"],
  "b/page.html": ["b/page.html", "b/local.png", "b/loop.html", "shared/end.html", "shared/media.png"],
};

test("each SCO declares exactly its entry's reachable closure", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  assert.equal(result.scos.length, 2);

  for (const sco of result.scos) {
    const entry = SNAPSHOT.modules[sco.moduleIndex].entry;
    // Independently computed closure, mapped through the package layout.
    const independent = independentClosure(dir, entry);
    const expectedSources = new Set(EXPECTED_CLOSURES[entry]);
    assert.deepEqual(independent, expectedSources, "independent closure matches expectation");
    const expectedPackagePaths = new Set(
      [...independent].map((sourcePath) => {
        const pkg = result.pathMap.get(sourcePath);
        assert.ok(pkg, `packed: ${sourcePath}`);
        return pkg;
      }),
    );
    assert.deepEqual(new Set(sco.files), expectedPackagePaths, `SCO ${sco.resourceIdentifier}`);
    assert.equal(sco.files.length, expectedPackagePaths.size, "no duplicate declarations");
    // The entry itself is the resource href.
    assert.equal(sco.entryPackagePath, result.pathMap.get(entry));
    assert.ok(sco.files.includes(sco.entryPackagePath));
  }
});

test("manifest file lists match the per-SCO closures", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const resourceBlocks = [...result.manifest.matchAll(/<resource[^>]*>([\s\S]*?)<\/resource>/g)];
  assert.equal(resourceBlocks.length, 2);
  for (let i = 0; i < resourceBlocks.length; i++) {
    const declared = [...resourceBlocks[i][1].matchAll(/<file href="([^"]+)"\/>/g)].map((x) => x[1]);
    assert.deepEqual(new Set(declared), new Set(result.scos[i].files));
  }
});

test("identical HTML in different directories resolves against its own dir", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const packedA = result.files.find((f) => f.sourcePath === "a/page.html") as { data: Buffer };
  const packedB = result.files.find((f) => f.sourcePath === "b/page.html") as { data: Buffer };
  // Same source bytes, different rewritten output.
  assert.notEqual(packedA.data.toString("utf8"), packedB.data.toString("utf8"));
  const localA = result.pathMap.get("a/local.png") as string;
  const localB = result.pathMap.get("b/local.png") as string;
  assert.ok(packedA.data.toString("utf8").includes(`"${localA.split("/").pop()}"`));
  assert.ok(packedB.data.toString("utf8").includes(`"${localB.split("/").pop()}"`));
});

test("shared media is packed once and unreachable files excluded", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const mediaEntries = result.files.filter((f) => f.sourcePath === "shared/media.png");
  assert.equal(mediaEntries.length, 1);
  const endEntries = result.files.filter((f) => f.sourcePath === "shared/end.html");
  assert.equal(endEntries.length, 1);
  assert.ok(!result.files.some((f) => f.sourcePath === "unused/dead.html"));
  assert.ok(!result.files.some((f) => f.sourcePath === "junk.bin"));
  // Total: 4 html + 2 local png + shared html + shared png + manifest.
  assert.equal(result.files.length, 9);
});

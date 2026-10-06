import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildPackage, exportZip } from "../src/index.ts";
import { extractHtmlRefs, decodeHtmlEntities } from "../src/htmlRefs.ts";
import { isExternalUrl, resolveLocalUrl } from "../src/urlResolve.ts";
import { makeSourceDir, readZip } from "./helpers.ts";

const ENTRY = "模块 一/index.html";
const PAGE2 = "模块 一/page&2.html";

const FIXTURE: Record<string, string | Buffer> = {
  [ENTRY]: [
    "<!DOCTYPE html><html><head>",
    '<link href="../css/样式.css?ver=1#top" rel="stylesheet">',
    "</head><body>",
    '<img src="图片 100%25.png">',
    "<a href='page&amp;2.html?x=1&amp;y=2#frag'>下一页</a>",
    '<script src="https://cdn.example.com/lib.js"></script>',
    '<img src="data:image/png;base64,AA==">',
    "<!-- <img src=\"commented-out.png\"> -->",
    "<script>var fake = \"<a href='not-a-ref.html'>\";</script>",
    "</body></html>",
  ].join("\n"),
  [PAGE2]: [
    "<html><body>",
    '<a HREF="index.html#back">返回</a>',
    '<img src="../media/%E5%9C%96.png?v=2">',
    '<a href="?self=1#me">self</a>',
    "</body></html>",
  ].join("\n"),
  "css/样式.css": "body { color: red; }",
  "media/圖.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
  "模块 一/图片 100%.png": Buffer.from([1, 2, 3, 4, 5]),
  "无关/unused.txt": "never referenced",
};

const SNAPSHOT = {
  title: "课程 <标题> & “引号”",
  modules: [
    { title: "模块 一 <A&B>", entry: ENTRY },
    { title: "模块 二", entry: PAGE2 },
  ],
};

function relativePosix(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) {
    common++;
  }
  return "../".repeat(fromDir.length - common) + toParts.slice(common).join("/");
}

test("package paths are ASCII and free of case-insensitive conflicts", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const seen = new Set<string>();
  for (const file of result.files) {
    assert.match(file.packagePath, /^[\x20-\x7e]+$/, `non-ASCII path: ${file.packagePath}`);
    const lower = file.packagePath.toLowerCase();
    assert.ok(!seen.has(lower), `case-insensitive conflict: ${file.packagePath}`);
    seen.add(lower);
  }
});

test("every local reference in exported HTML reaches the correct resource", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const packedByPath = new Map(result.files.map((f) => [f.packagePath, f]));

  for (const sourcePath of [ENTRY, PAGE2]) {
    const sourceHtml = (FIXTURE[sourcePath] as string);
    const packagePath = result.pathMap.get(sourcePath) as string;
    const rewritten = (packedByPath.get(packagePath) as { data: Buffer }).data.toString("utf8");
    const sourceRefs = extractHtmlRefs(sourceHtml);
    const packedRefs = extractHtmlRefs(rewritten);
    assert.equal(packedRefs.length, sourceRefs.length, "ref count must be preserved");

    for (let i = 0; i < sourceRefs.length; i++) {
      const original = decodeHtmlEntities(sourceRefs[i].rawValue);
      const rewrittenValue = decodeHtmlEntities(packedRefs[i].rawValue);
      if (isExternalUrl(original)) {
        assert.equal(rewrittenValue, original, "external URLs stay untouched");
        continue;
      }
      const resolved = resolveLocalUrl(original, sourcePath);
      const targetPackage = result.pathMap.get(resolved.sourcePath);
      assert.ok(targetPackage, `target packed: ${resolved.sourcePath}`);
      const expected =
        relativePosix(packagePath, targetPackage) + resolved.query + resolved.fragment;
      assert.equal(rewrittenValue, expected, `ref #${i} in ${sourcePath}`);
      // The rewritten reference must resolve to an actual packed file.
      const lookup = resolveLocalUrl(rewrittenValue, packagePath);
      assert.ok(packedByPath.has(lookup.sourcePath), `resolves in package: ${rewrittenValue}`);
    }
  }
});

test("non-HTML files are packed byte-identically", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  for (const sourcePath of ["css/样式.css", "media/圖.png", "模块 一/图片 100%.png"]) {
    const packed = result.files.find((f) => f.sourcePath === sourcePath);
    assert.ok(packed, `packed: ${sourcePath}`);
    const original = readFileSync(join(dir, ...sourcePath.split("/")));
    assert.deepEqual(packed.data, original, `bytes identical: ${sourcePath}`);
  }
});

test("unreachable files are excluded and each source file packed once", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  assert.ok(!result.files.some((f) => f.sourcePath === "无关/unused.txt"));
  const sourcePaths = result.files.filter((f) => f.sourcePath !== null).map((f) => f.sourcePath);
  assert.equal(new Set(sourcePaths).size, sourcePaths.length, "no duplicate source entries");
});

test("zip export round-trips to the same files", () => {
  const dir = makeSourceDir(FIXTURE);
  const out = join(dir, "out.zip");
  exportZip(SNAPSHOT, dir, out);
  const entries = readZip(readFileSync(out));
  const result = buildPackage(SNAPSHOT, dir);
  assert.equal(entries.size, result.files.length);
  for (const file of result.files) {
    const data = entries.get(file.packagePath);
    assert.ok(data, `zip contains ${file.packagePath}`);
    assert.deepEqual(data, file.data, `zip content matches: ${file.packagePath}`);
  }
  assert.ok(entries.has("imsmanifest.xml"), "manifest at zip root");
});

test("manifest uses SCORM 1.2 metadata and preserves titles", () => {
  const dir = makeSourceDir(FIXTURE);
  const result = buildPackage(SNAPSHOT, dir);
  const m = result.manifest;
  assert.match(m, /<schema>ADL SCORM<\/schema>/);
  assert.match(m, /<schemaversion>1\.2<\/schemaversion>/);
  assert.match(m, /xmlns="http:\/\/www\.imsproject\.org\/xsd\/imscp_rootv1p1p2"/);
  assert.match(m, /xmlns:adlcp="http:\/\/www\.adlnet\.org\/xsd\/adlcp_rootv1p2"/);
  assert.match(m, /adlcp:scormtype="sco"/);
  // Titles are XML-escaped but otherwise verbatim.
  assert.ok(m.includes("课程 &lt;标题&gt; &amp; “引号”"));
  assert.ok(m.includes("模块 一 &lt;A&amp;B&gt;"));
  // Every item references an existing resource and vice versa.
  const itemRefs = [...m.matchAll(/identifierref="([^"]+)"/g)].map((x) => x[1]);
  const resourceIds = [...m.matchAll(/<resource identifier="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual([...itemRefs].sort(), [...resourceIds].sort());
});

test("missing entry or dangling local reference fails loudly", () => {
  const dir = makeSourceDir(FIXTURE);
  assert.throws(
    () => buildPackage({ title: "t", modules: [{ title: "m", entry: "no/such.html" }] }, dir),
    /missing source file: no\/such\.html/,
  );
  const dir2 = makeSourceDir({ "index.html": '<img src="gone.png">' });
  assert.throws(
    () => buildPackage({ title: "t", modules: [{ title: "m", entry: "index.html" }] }, dir2),
    /missing source file: gone\.png/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isExternalUrl, resolveLocalUrl } from "../src/urlResolve.ts";

test("treats https: and data: URLs as external", () => {
  assert.equal(isExternalUrl("https://example.com/a.js"), true);
  assert.equal(isExternalUrl("data:image/png;base64,AA=="), true);
});

test("treats any scheme, host or leading slash as external", () => {
  assert.equal(isExternalUrl("http://example.com"), true);
  assert.equal(isExternalUrl("//example.com/x"), true);
  assert.equal(isExternalUrl("/abs/path"), true);
  assert.equal(isExternalUrl("mailto:a@b.c"), true);
  assert.equal(isExternalUrl("rel/path.png"), false);
  assert.equal(isExternalUrl("?q=1"), false);
  assert.equal(isExternalUrl("#frag"), false);
});

test("resolves relative paths against the HTML directory", () => {
  assert.equal(resolveLocalUrl("a/b.png", "mod/index.html").sourcePath, "mod/a/b.png");
  assert.equal(resolveLocalUrl("../shared/x.png", "mod/sub/page.html").sourcePath, "mod/shared/x.png");
  assert.equal(resolveLocalUrl("./dot.png", "m/index.html").sourcePath, "m/dot.png");
});

test("decodes each path segment once as UTF-8", () => {
  assert.equal(
    resolveLocalUrl("%e4%b8%ad%e6%96%87/%E5%9C%96%20%E7%89%87.png", "m/index.html").sourcePath,
    "m/中文/圖 片.png",
  );
  // A literal '%' in the file name is addressed via %25.
  assert.equal(resolveLocalUrl("100%25 done.png", "m/index.html").sourcePath, "m/100% done.png");
});

test("keeps query and fragment out of the lookup but preserves them", () => {
  const r = resolveLocalUrl("a.png?x=1&y=%41#sec-2", "m/index.html");
  assert.equal(r.sourcePath, "m/a.png");
  assert.equal(r.query, "?x=1&y=%41");
  assert.equal(r.fragment, "#sec-2");
});

test("empty path refers to the containing HTML itself", () => {
  assert.equal(resolveLocalUrl("#only", "m/index.html").sourcePath, "m/index.html");
  assert.equal(resolveLocalUrl("?q=1", "m/index.html").sourcePath, "m/index.html");
  assert.equal(resolveLocalUrl("", "m/index.html").sourcePath, "m/index.html");
});

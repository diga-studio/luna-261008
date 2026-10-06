import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlEntities, extractHtmlRefs } from "../src/htmlRefs.ts";

test("extracts href/src regardless of attribute name case", () => {
  const refs = extractHtmlRefs('<a HREF="a.html"><IMG SRC=b.png><link Href=\'c.css\'>');
  assert.deepEqual(refs.map((r) => r.rawValue), ["a.html", "b.png", "c.css"]);
});

test("supports quoted, single-quoted and unquoted values", () => {
  const refs = extractHtmlRefs("<a href=\"x.html\"> <a href='y.html'> <a href=z.html>");
  assert.deepEqual(refs.map((r) => r.rawValue), ["x.html", "y.html", "z.html"]);
});

test("ignores references inside comments", () => {
  const refs = extractHtmlRefs('<!-- <img src="no.png"> --><img src="yes.png">');
  assert.deepEqual(refs.map((r) => r.rawValue), ["yes.png"]);
});

test("ignores references inside script and style text", () => {
  const html =
    '<script>var a = "<img src=no1.png>";</script>' +
    "<style>.x{background:url(no2.png)} /* <a href=no3.html> */</style>" +
    '<SCRIPT type="text/javascript">document.write("<a href=no4.html>")</SCRIPT>' +
    '<img src="yes.png">';
  const refs = extractHtmlRefs(html);
  assert.deepEqual(refs.map((r) => r.rawValue), ["yes.png"]);
});

test("script closing tag inside script string still terminates scanning safely", () => {
  const refs = extractHtmlRefs('<script>var s="</scr" + "ipt>";</script><a href="ok.html">');
  assert.deepEqual(refs.map((r) => r.rawValue), ["ok.html"]);
});

test("ignores other attributes and non-element markup", () => {
  const refs = extractHtmlRefs(
    '<?xml version="1.0"?><!DOCTYPE html><a data-href="no.html" href="yes.html">',
  );
  assert.deepEqual(refs.map((r) => r.rawValue), ["yes.html"]);
});

test("decodes named and numeric character references", () => {
  assert.equal(decodeHtmlEntities("a&amp;b&lt;c&gt;d&quot;e&apos;f"), "a&b<c>d\"e'f");
  assert.equal(decodeHtmlEntities("&#72;&#x49;&#x4e2d;"), "HI中");
  assert.equal(decodeHtmlEntities("100%25&nbsp;x"), "100%25 x");
});

test("leaves unknown entities untouched", () => {
  assert.equal(decodeHtmlEntities("&notanentity; &fake"), "&notanentity; &fake");
});

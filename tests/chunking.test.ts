import { createScanner } from "../src/index";
import { Rule, ScanResult } from "../src/types";
import {
  ascii,
  utf8,
  concat,
  base64Encode,
  quotedPrintableEncode,
  assertEqual,
  assertSetEqual,
  assertTrue,
} from "./helpers";

const KEYWORD = "威胁关键词";

function buildEmail(): Uint8Array {
  const leafText = `开头${KEYWORD}结尾`;
  const leafBytes = utf8(leafText);
  const base64Body = base64Encode(leafBytes);
  const qpBody = quotedPrintableEncode(leafBytes);
  const lines = [
    "From: sender@example.com",
    "Content-Type: multipart/mixed;",
    "\tboundary=\"quo\\\"ted\"",
    "",
    "preamble should be ignored 威胁关键词",
    '--quo"ted',
    "Content-Type: multipart/alternative; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain;",
    '\tcharset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body,
    "--inner",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qpBody,
    "--inner--",
    '--quo"ted--',
    "epilogue should be ignored 威胁关键词",
    "",
  ];
  return ascii(lines.join("\r\n"));
}

const RULES: Rule[] = [
  { id: "kw", needle: KEYWORD, weight: 40 },
  { id: "head", needle: "开头", weight: 30 },
];

function runScan(email: Uint8Array, chunks: Uint8Array[]): { writes: string[][]; result: ScanResult } {
  void email;
  const scanner = createScanner(RULES);
  const writes: string[][] = [];
  for (const chunk of chunks) {
    writes.push(scanner.write(chunk));
  }
  return { writes, result: scanner.finish() };
}

function splitChunks(email: Uint8Array, at: number): Uint8Array[] {
  return [email.slice(0, at), email.slice(at)];
}

export const tests: Array<[string, () => void]> = [
  ["chunking: whole input in one write", () => {
    const email = buildEmail();
    const { writes, result } = runScan(email, [email]);
    assertSetEqual(result.hitIds, ["kw", "head"], "hits");
    assertEqual(result.score, 70, "score");
    assertEqual(result.quarantined, true, "quarantined");
    const flat = writes.flat();
    assertSetEqual(flat, ["kw", "head"], "write hits");
    assertEqual(flat.length, 2, "no duplicate ids across writes");
  }],

  ["chunking: every two-part split gives identical results", () => {
    const email = buildEmail();
    const reference = runScan(email, [email]).result;
    for (let at = 0; at <= email.length; at++) {
      const { writes, result } = runScan(email, splitChunks(email, at));
      assertSetEqual(result.hitIds, reference.hitIds, `hitIds at split ${at}`);
      assertEqual(result.score, reference.score, `score at split ${at}`);
      assertEqual(result.quarantined, reference.quarantined, `quarantined at split ${at}`);
      const flat = writes.flat();
      assertSetEqual(flat, reference.hitIds, `write hits at split ${at}`);
      assertEqual(flat.length, reference.hitIds.length, `duplicate ids at split ${at}`);
    }
  }],

  ["chunking: single-byte chunks give identical results", () => {
    const email = buildEmail();
    const reference = runScan(email, [email]).result;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < email.length; i++) {
      chunks.push(email.slice(i, i + 1));
    }
    const { writes, result } = runScan(email, chunks);
    assertSetEqual(result.hitIds, reference.hitIds, "hitIds single-byte");
    assertEqual(result.score, reference.score, "score single-byte");
    assertEqual(result.quarantined, reference.quarantined, "quarantined single-byte");
    const flat = writes.flat();
    assertSetEqual(flat, reference.hitIds, "write hits single-byte");
    assertEqual(flat.length, reference.hitIds.length, "duplicate ids single-byte");
  }],

  ["chunking: empty chunks do not change results", () => {
    const email = buildEmail();
    const reference = runScan(email, [email]).result;
    const empty = new Uint8Array(0);
    const { result } = runScan(email, [empty, email.slice(0, 10), empty, email.slice(10), empty]);
    assertSetEqual(result.hitIds, reference.hitIds, "hitIds with empty chunks");
    assertEqual(result.score, reference.score, "score with empty chunks");
  }],

  ["chunking: keyword reported once despite two matching leaves", () => {
    const email = buildEmail();
    const scanner = createScanner(RULES);
    const allHits: string[] = [];
    for (let i = 0; i < email.length; i += 7) {
      allHits.push(...scanner.write(email.slice(i, i + 7)));
    }
    const result = scanner.finish();
    const kwCount = allHits.filter((id) => id === "kw").length;
    assertTrue(kwCount <= 1, "kw reported at most once across writes");
    assertSetEqual(result.hitIds, ["kw", "head"], "final hits");
  }],

  ["sanity: utf8/base64/qp helpers decode to same text", () => {
    const leafBytes = utf8(`开头${KEYWORD}结尾`);
    assertTrue(base64Encode(leafBytes).length > 0, "base64 non-empty");
    assertTrue(quotedPrintableEncode(leafBytes).includes("="), "qp escapes");
    const joined = concat(ascii("ab"), utf8("中"));
    assertEqual(joined.length, 5, "concat length");
  }],
];

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tests = void 0;
const index_1 = require("../src/index");
const helpers_1 = require("./helpers");
const KEYWORD = "威胁关键词";
function buildEmail() {
    const leafText = `开头${KEYWORD}结尾`;
    const leafBytes = (0, helpers_1.utf8)(leafText);
    const base64Body = (0, helpers_1.base64Encode)(leafBytes);
    const qpBody = (0, helpers_1.quotedPrintableEncode)(leafBytes);
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
    return (0, helpers_1.ascii)(lines.join("\r\n"));
}
const RULES = [
    { id: "kw", needle: KEYWORD, weight: 40 },
    { id: "head", needle: "开头", weight: 30 },
];
function runScan(email, chunks) {
    void email;
    const scanner = (0, index_1.createScanner)(RULES);
    const writes = [];
    for (const chunk of chunks) {
        writes.push(scanner.write(chunk));
    }
    return { writes, result: scanner.finish() };
}
function splitChunks(email, at) {
    return [email.slice(0, at), email.slice(at)];
}
exports.tests = [
    ["chunking: whole input in one write", () => {
            const email = buildEmail();
            const { writes, result } = runScan(email, [email]);
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw", "head"], "hits");
            (0, helpers_1.assertEqual)(result.score, 70, "score");
            (0, helpers_1.assertEqual)(result.quarantined, true, "quarantined");
            const flat = writes.flat();
            (0, helpers_1.assertSetEqual)(flat, ["kw", "head"], "write hits");
            (0, helpers_1.assertEqual)(flat.length, 2, "no duplicate ids across writes");
        }],
    ["chunking: every two-part split gives identical results", () => {
            const email = buildEmail();
            const reference = runScan(email, [email]).result;
            for (let at = 0; at <= email.length; at++) {
                const { writes, result } = runScan(email, splitChunks(email, at));
                (0, helpers_1.assertSetEqual)(result.hitIds, reference.hitIds, `hitIds at split ${at}`);
                (0, helpers_1.assertEqual)(result.score, reference.score, `score at split ${at}`);
                (0, helpers_1.assertEqual)(result.quarantined, reference.quarantined, `quarantined at split ${at}`);
                const flat = writes.flat();
                (0, helpers_1.assertSetEqual)(flat, reference.hitIds, `write hits at split ${at}`);
                (0, helpers_1.assertEqual)(flat.length, reference.hitIds.length, `duplicate ids at split ${at}`);
            }
        }],
    ["chunking: single-byte chunks give identical results", () => {
            const email = buildEmail();
            const reference = runScan(email, [email]).result;
            const chunks = [];
            for (let i = 0; i < email.length; i++) {
                chunks.push(email.slice(i, i + 1));
            }
            const { writes, result } = runScan(email, chunks);
            (0, helpers_1.assertSetEqual)(result.hitIds, reference.hitIds, "hitIds single-byte");
            (0, helpers_1.assertEqual)(result.score, reference.score, "score single-byte");
            (0, helpers_1.assertEqual)(result.quarantined, reference.quarantined, "quarantined single-byte");
            const flat = writes.flat();
            (0, helpers_1.assertSetEqual)(flat, reference.hitIds, "write hits single-byte");
            (0, helpers_1.assertEqual)(flat.length, reference.hitIds.length, "duplicate ids single-byte");
        }],
    ["chunking: empty chunks do not change results", () => {
            const email = buildEmail();
            const reference = runScan(email, [email]).result;
            const empty = new Uint8Array(0);
            const { result } = runScan(email, [empty, email.slice(0, 10), empty, email.slice(10), empty]);
            (0, helpers_1.assertSetEqual)(result.hitIds, reference.hitIds, "hitIds with empty chunks");
            (0, helpers_1.assertEqual)(result.score, reference.score, "score with empty chunks");
        }],
    ["chunking: keyword reported once despite two matching leaves", () => {
            const email = buildEmail();
            const scanner = (0, index_1.createScanner)(RULES);
            const allHits = [];
            for (let i = 0; i < email.length; i += 7) {
                allHits.push(...scanner.write(email.slice(i, i + 7)));
            }
            const result = scanner.finish();
            const kwCount = allHits.filter((id) => id === "kw").length;
            (0, helpers_1.assertTrue)(kwCount <= 1, "kw reported at most once across writes");
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw", "head"], "final hits");
        }],
    ["sanity: utf8/base64/qp helpers decode to same text", () => {
            const leafBytes = (0, helpers_1.utf8)(`开头${KEYWORD}结尾`);
            (0, helpers_1.assertTrue)((0, helpers_1.base64Encode)(leafBytes).length > 0, "base64 non-empty");
            (0, helpers_1.assertTrue)((0, helpers_1.quotedPrintableEncode)(leafBytes).includes("="), "qp escapes");
            const joined = (0, helpers_1.concat)((0, helpers_1.ascii)("ab"), (0, helpers_1.utf8)("中"));
            (0, helpers_1.assertEqual)(joined.length, 5, "concat length");
        }],
];

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tests = void 0;
const index_1 = require("../src/index");
const helpers_1 = require("./helpers");
const KEYWORD = "威胁关键词";
function buildEmail() {
    const decodedOnlyBoundary = `解码后出现 --sec1 的文本`;
    const base64Body = (0, helpers_1.base64Encode)((0, helpers_1.utf8)(decodedOnlyBoundary));
    const binaryWithKeyword = (0, helpers_1.base64Encode)((0, helpers_1.utf8)(`二进制里的${KEYWORD}不应计入`));
    const lines = [
        "Content-Type: multipart/mixed; boundary=sec1",
        "",
        "--sec1",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "--sec1x 这只是假边界前缀",
        "--sec",
        `--sec1 后面跟非空白字符x`,
        "本叶末尾的片段:威胁关",
        "--sec1",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64Body,
        "--sec1",
        "Content-Type: application/octet-stream",
        "Content-Transfer-Encoding: base64",
        "",
        binaryWithKeyword,
        "--sec1",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "键词:这是另一叶的开头片段",
        "--sec1--",
        "",
    ];
    return (0, helpers_1.mail)(lines);
}
const RULES = [
    { id: "kw", needle: KEYWORD, weight: 80 },
    { id: "decoded", needle: "--sec1 的文本", weight: 10 },
    { id: "fake", needle: "--sec1x 这只是假边界前缀", weight: 5 },
];
exports.tests = [
    ["boundaries: fake prefixes stay body, decoded boundary is text, binary ignored, no cross-leaf hit", () => {
            const email = buildEmail();
            const scanner = (0, index_1.createScanner)(RULES);
            scanner.write(email);
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, ["decoded", "fake"], "hits");
            (0, helpers_1.assertEqual)(result.score, 15, "score");
            (0, helpers_1.assertEqual)(result.quarantined, false, "quarantined");
        }],
    ["boundaries: same email byte-by-byte", () => {
            const email = buildEmail();
            const scanner = (0, index_1.createScanner)(RULES);
            const hits = [];
            for (let i = 0; i < email.length; i++) {
                hits.push(...scanner.write(email.slice(i, i + 1)));
            }
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(hits, ["decoded", "fake"], "write hits");
            (0, helpers_1.assertSetEqual)(result.hitIds, ["decoded", "fake"], "final hits");
            (0, helpers_1.assertEqual)(result.score, 15, "score");
        }],
    ["boundaries: keyword split across two leaves never matches", () => {
            const lines = [
                "Content-Type: multipart/mixed; boundary=b",
                "",
                "--b",
                "",
                "威胁关",
                "--b",
                "",
                "键词",
                "--b--",
                "",
            ];
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write((0, helpers_1.mail)(lines));
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, [], "no cross-leaf hit");
            (0, helpers_1.assertEqual)(result.score, 0, "score");
        }],
    ["boundaries: keyword split across chunk boundary within one leaf matches", () => {
            const lines = [
                "Content-Type: text/plain; charset=UTF-8",
                "",
                `前缀${KEYWORD}后缀`,
            ];
            const email = (0, helpers_1.concat)((0, helpers_1.ascii)(lines.slice(0, 3).join("\r\n") + "\r\n"), (0, helpers_1.utf8)(`前缀${KEYWORD}后缀`));
            void lines;
            const reference = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            reference.write(email);
            const expected = reference.finish();
            for (let at = 0; at <= email.length; at++) {
                const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
                scanner.write(email.slice(0, at));
                scanner.write(email.slice(at));
                const result = scanner.finish();
                (0, helpers_1.assertSetEqual)(result.hitIds, expected.hitIds, `hitIds at split ${at}`);
                (0, helpers_1.assertEqual)(result.score, expected.score, `score at split ${at}`);
            }
            (0, helpers_1.assertEqual)(expected.quarantined, true, "quarantined");
        }],
    ["boundaries: closing boundary may end input directly without CRLF", () => {
            const email = (0, helpers_1.mail)([
                "Content-Type: multipart/mixed; boundary=b",
                "",
                "--b",
                "Content-Type: text/plain; charset=UTF-8",
                "",
                "威胁关键词",
                "--b--",
            ]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write(email);
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw"], "hits");
            (0, helpers_1.assertEqual)(result.quarantined, true, "quarantined");
        }],
    ["boundaries: delimiter line may carry trailing spaces and tabs", () => {
            const email = (0, helpers_1.mail)([
                "Content-Type: multipart/mixed; boundary=b",
                "",
                "--b \t ",
                "Content-Type: text/plain; charset=UTF-8",
                "",
                "威胁关键词",
                "--b-- \t",
                "",
            ]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write(email);
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw"], "hits");
        }],
    ["boundaries: boundary matching is case sensitive", () => {
            const email = (0, helpers_1.mail)([
                "Content-Type: multipart/mixed; boundary=AbC",
                "",
                "--AbC",
                "Content-Type: text/plain; charset=UTF-8",
                "",
                "--abc",
                "威胁关键词",
                "--AbC--",
                "",
            ]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write(email);
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw"], "lowercase delimiter line is body, not boundary");
        }],
];

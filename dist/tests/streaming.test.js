"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tests = void 0;
const index_1 = require("../src/index");
const helpers_1 = require("./helpers");
const KEYWORD = "威胁关键词";
const BODY_SIZE = 20 * 1024 * 1024;
function buildHeaders() {
    return [
        "Content-Type: multipart/mixed; boundary=big",
        "",
        "--big",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "",
    ].join("\r\n");
}
const CLOSING = "\r\n--big--\r\n";
function makeBody() {
    const body = new Uint8Array(BODY_SIZE);
    body.fill(0x78);
    return body;
}
exports.tests = [
    ["streaming: 20 MiB leaf reports hit from write before finish", () => {
            const head = (0, helpers_1.mail)([buildHeaders()]);
            const body = makeBody();
            const keywordAtStart = (0, helpers_1.mail)([`${KEYWORD} `]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            const hits = [];
            const chunkSize = 64 * 1024;
            const push = (bytes) => {
                let i = 0;
                while (i < bytes.length) {
                    const end = Math.min(i + chunkSize, bytes.length);
                    hits.push(...scanner.write(bytes.slice(i, end)));
                    i = end;
                }
            };
            push(head);
            push(keywordAtStart);
            (0, helpers_1.assertTrue)(hits.includes("kw"), "hit reported by write before body finished");
            push(body);
            push(new TextEncoder().encode(CLOSING));
            const result = scanner.finish();
            (0, helpers_1.assertSetEqual)(result.hitIds, ["kw"], "final hits");
            (0, helpers_1.assertEqual)(result.score, 80, "score");
            (0, helpers_1.assertEqual)(result.quarantined, true, "quarantined");
            (0, helpers_1.assertEqual)(hits.filter((id) => id === "kw").length, 1, "reported exactly once");
        }],
    ["streaming: missing closing boundary makes finish fail", () => {
            const head = (0, helpers_1.mail)([buildHeaders()]);
            const body = makeBody().slice(0, 1024);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write(head);
            scanner.write((0, helpers_1.mail)([KEYWORD]));
            scanner.write(body);
            (0, helpers_1.assertThrows)(() => scanner.finish(), "unclosed multipart must throw");
        }],
    ["streaming: nested multipart missing inner closing boundary fails", () => {
            const email = (0, helpers_1.mail)([
                "Content-Type: multipart/mixed; boundary=out",
                "",
                "--out",
                "Content-Type: multipart/mixed; boundary=in",
                "",
                "--in",
                "",
                "威胁关键词",
                "--out--",
                "",
            ]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            (0, helpers_1.assertThrows)(() => {
                scanner.write(email);
                scanner.finish();
            }, "inner multipart unclosed must throw");
        }],
    ["streaming: input ending inside nested multipart fails at finish", () => {
            const email = (0, helpers_1.mail)([
                "Content-Type: multipart/mixed; boundary=out",
                "",
                "--out",
                "Content-Type: multipart/mixed; boundary=in",
                "",
                "--in",
                "",
                "威胁关键词",
                "--in--",
                "",
            ]);
            const scanner = (0, index_1.createScanner)([{ id: "kw", needle: KEYWORD, weight: 80 }]);
            scanner.write(email);
            (0, helpers_1.assertThrows)(() => scanner.finish(), "outer multipart unclosed must throw");
        }],
];

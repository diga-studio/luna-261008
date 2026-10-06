import { createScanner } from "../src/index";
import { Rule } from "../src/types";
import {
  ascii,
  utf8,
  concat,
  mail,
  base64Encode,
  assertEqual,
  assertSetEqual,
} from "./helpers";

const KEYWORD = "威胁关键词";

function buildEmail(): Uint8Array {
  const decodedOnlyBoundary = `解码后出现 --sec1 的文本`;
  const base64Body = base64Encode(utf8(decodedOnlyBoundary));
  const binaryWithKeyword = base64Encode(utf8(`二进制里的${KEYWORD}不应计入`));
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
  return mail(lines);
}

const RULES: Rule[] = [
  { id: "kw", needle: KEYWORD, weight: 80 },
  { id: "decoded", needle: "--sec1 的文本", weight: 10 },
  { id: "fake", needle: "--sec1x 这只是假边界前缀", weight: 5 },
];

export const tests: Array<[string, () => void]> = [
  ["boundaries: fake prefixes stay body, decoded boundary is text, binary ignored, no cross-leaf hit", () => {
    const email = buildEmail();
    const scanner = createScanner(RULES);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["decoded", "fake"], "hits");
    assertEqual(result.score, 15, "score");
    assertEqual(result.quarantined, false, "quarantined");
  }],

  ["boundaries: same email byte-by-byte", () => {
    const email = buildEmail();
    const scanner = createScanner(RULES);
    const hits: string[] = [];
    for (let i = 0; i < email.length; i++) {
      hits.push(...scanner.write(email.slice(i, i + 1)));
    }
    const result = scanner.finish();
    assertSetEqual(hits, ["decoded", "fake"], "write hits");
    assertSetEqual(result.hitIds, ["decoded", "fake"], "final hits");
    assertEqual(result.score, 15, "score");
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
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(mail(lines));
    const result = scanner.finish();
    assertSetEqual(result.hitIds, [], "no cross-leaf hit");
    assertEqual(result.score, 0, "score");
  }],

  ["boundaries: keyword split across chunk boundary within one leaf matches", () => {
    const lines = [
      "Content-Type: text/plain; charset=UTF-8",
      "",
      `前缀${KEYWORD}后缀`,
    ];
    const email = concat(ascii(lines.slice(0, 3).join("\r\n") + "\r\n"), utf8(`前缀${KEYWORD}后缀`));
    void lines;
    const reference = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    reference.write(email);
    const expected = reference.finish();
    for (let at = 0; at <= email.length; at++) {
      const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
      scanner.write(email.slice(0, at));
      scanner.write(email.slice(at));
      const result = scanner.finish();
      assertSetEqual(result.hitIds, expected.hitIds, `hitIds at split ${at}`);
      assertEqual(result.score, expected.score, `score at split ${at}`);
    }
    assertEqual(expected.quarantined, true, "quarantined");
  }],

  ["boundaries: closing boundary may end input directly without CRLF", () => {
    const email = mail([
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "威胁关键词",
      "--b--",
    ]);
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["kw"], "hits");
    assertEqual(result.quarantined, true, "quarantined");
  }],

  ["boundaries: delimiter line may carry trailing spaces and tabs", () => {
    const email = mail([
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b \t ",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "威胁关键词",
      "--b-- \t",
      "",
    ]);
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["kw"], "hits");
  }],

  ["boundaries: boundary matching is case sensitive", () => {
    const email = mail([
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
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["kw"], "lowercase delimiter line is body, not boundary");
  }],
];

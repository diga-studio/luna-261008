import { createScanner } from "../src/index";
import { mail, ascii, assertEqual, assertSetEqual, assertThrows, assertTrue } from "./helpers";

const KEYWORD = "威胁关键词";

export const tests: Array<[string, () => void]> = [
  ["rules: duplicate id rejected", () => {
    assertThrows(
      () => createScanner([
        { id: "a", needle: "x", weight: 1 },
        { id: "a", needle: "y", weight: 1 },
      ]),
      "duplicate id"
    );
  }],

  ["rules: empty needle rejected", () => {
    assertThrows(() => createScanner([{ id: "a", needle: "", weight: 1 }]), "empty needle");
  }],

  ["rules: non-positive weight rejected", () => {
    assertThrows(() => createScanner([{ id: "a", needle: "x", weight: 0 }]), "zero weight");
    assertThrows(() => createScanner([{ id: "a", needle: "x", weight: -3 }]), "negative weight");
    assertThrows(() => createScanner([{ id: "a", needle: "x", weight: 1.5 }]), "fractional weight");
  }],

  ["score: capped at 100", () => {
    const email = mail([
      "Content-Type: text/plain; charset=UTF-8",
      "",
      `${KEYWORD} and secret and malware`,
    ]);
    const scanner = createScanner([
      { id: "a", needle: KEYWORD, weight: 60 },
      { id: "b", needle: "secret", weight: 50 },
      { id: "c", needle: "malware", weight: 30 },
    ]);
    scanner.write(email);
    const result = scanner.finish();
    assertEqual(result.score, 100, "score capped");
    assertEqual(result.quarantined, true, "quarantined");
  }],

  ["score: below threshold not quarantined", () => {
    const email = mail(["Content-Type: text/plain; charset=UTF-8", "", KEYWORD]);
    const scanner = createScanner([{ id: "a", needle: KEYWORD, weight: 69 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertEqual(result.score, 69, "score");
    assertEqual(result.quarantined, false, "not quarantined");
  }],

  ["headers: part headers over 8 KiB rejected", () => {
    const padding = "X-Long: " + "a".repeat(9000);
    const email = mail([
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      padding,
      "",
      "body",
      "--b--",
      "",
    ]);
    const scanner = createScanner([{ id: "a", needle: "body", weight: 1 }]);
    assertThrows(() => scanner.write(email), "oversized part headers");
  }],

  ["headers: folded and quoted params with escapes", () => {
    const email = mail([
      "content-type: text/plain;",
      "\tcharset = \"utf\\-8\" ;",
      "Content-TRANSFER-Encoding: 7BIT",
      "",
      KEYWORD,
    ]);
    const scanner = createScanner([{ id: "a", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "hits");
  }],

  ["nesting: deeper than 8 levels rejected", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(`Content-Type: multipart/mixed; boundary=b${i}`);
      lines.push("");
      lines.push(`--b${i}`);
    }
    const scanner = createScanner([{ id: "a", needle: "x", weight: 1 }]);
    assertThrows(() => scanner.write(ascii(lines.join("\r\n"))), "too deep");
  }],

  ["nesting: exactly 8 levels works", () => {
    const open: string[] = [];
    const close: string[] = [];
    for (let i = 0; i < 8; i++) {
      open.push(`Content-Type: multipart/mixed; boundary=b${i}`, "", `--b${i}`);
      close.unshift(`--b${i}--`);
    }
    const email = mail([...open, "Content-Type: text/plain; charset=UTF-8", "", KEYWORD, ...close, ""]);
    const scanner = createScanner([{ id: "a", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "hits at depth 8");
  }],

  ["boundary: longer than 70 chars rejected", () => {
    const boundary = "b".repeat(71);
    const email = ascii(`Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n--${boundary}\r\n\r\nx\r\n--${boundary}--\r\n`);
    const scanner = createScanner([{ id: "a", needle: "x", weight: 1 }]);
    assertThrows(() => scanner.write(email), "boundary too long");
  }],

  ["quoted-printable: soft line breaks join content", () => {
    const keyword = "secretkeyword";
    const split = "secretkey=\r\nword";
    const email = ascii(
      `Content-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${split}\r\n`
    );
    const scanner = createScanner([{ id: "a", needle: keyword, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "soft break joined");
  }],

  ["quoted-printable: split escape sequence across chunks", () => {
    const email = mail([
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "=E5=A8=81=E8=83=81=E5=85=B3=E9=94=AE=E8=AF=8D",
    ]);
    const scanner = createScanner([{ id: "a", needle: KEYWORD, weight: 80 }]);
    for (let i = 0; i < email.length; i++) {
      scanner.write(email.slice(i, i + 1));
    }
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "qp byte-by-byte");
  }],

  ["transfer: 8bit utf-8 content scanned", () => {
    const email = mail([
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      KEYWORD,
    ]);
    const scanner = createScanner([{ id: "a", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "8bit hits");
  }],

  ["defaults: no content-type means text/plain us-ascii 7bit", () => {
    const email = ascii("X-Other: 1\r\n\r\nplain secret body\r\n");
    const scanner = createScanner([{ id: "a", needle: "secret", weight: 80 }]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "default leaf scanned");
  }],

  ["matcher: overlapping needles and self-overlap", () => {
    const email = ascii("Content-Type: text/plain\r\n\r\naaaa\r\n");
    const scanner = createScanner([
      { id: "aa", needle: "aa", weight: 10 },
      { id: "aaa", needle: "aaa", weight: 10 },
    ]);
    scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["aa", "aaa"], "overlapping hits");
    assertEqual(result.score, 20, "score");
  }],

  ["matcher: case sensitive needles", () => {
    const email = ascii("Content-Type: text/plain\r\n\r\nSecret SECRET\r\n");
    const scanner = createScanner([{ id: "a", needle: "Secret", weight: 10 }]);
    const hits = scanner.write(email);
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["a"], "hit");
    assertEqual(hits.length, 1, "reported once despite two case variants");
    assertTrue(true, "done");
  }],
];

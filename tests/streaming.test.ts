import { createScanner } from "../src/index";
import { mail, assertEqual, assertSetEqual, assertThrows, assertTrue } from "./helpers";

const KEYWORD = "威胁关键词";
const BODY_SIZE = 20 * 1024 * 1024;

function buildHeaders(): string {
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

function makeBody(): Uint8Array {
  const body = new Uint8Array(BODY_SIZE);
  body.fill(0x78);
  return body;
}

export const tests: Array<[string, () => void]> = [
  ["streaming: 20 MiB leaf reports hit from write before finish", () => {
    const head = mail([buildHeaders()]);
    const body = makeBody();
    const keywordAtStart = mail([`${KEYWORD} `]);

    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    const hits: string[] = [];
    const chunkSize = 64 * 1024;
    const push = (bytes: Uint8Array) => {
      let i = 0;
      while (i < bytes.length) {
        const end = Math.min(i + chunkSize, bytes.length);
        hits.push(...scanner.write(bytes.slice(i, end)));
        i = end;
      }
    };
    push(head);
    push(keywordAtStart);
    assertTrue(hits.includes("kw"), "hit reported by write before body finished");
    push(body);
    push(new TextEncoder().encode(CLOSING));
    const result = scanner.finish();
    assertSetEqual(result.hitIds, ["kw"], "final hits");
    assertEqual(result.score, 80, "score");
    assertEqual(result.quarantined, true, "quarantined");
    assertEqual(hits.filter((id) => id === "kw").length, 1, "reported exactly once");
  }],

  ["streaming: missing closing boundary makes finish fail", () => {
    const head = mail([buildHeaders()]);
    const body = makeBody().slice(0, 1024);
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(head);
    scanner.write(mail([KEYWORD]));
    scanner.write(body);
    assertThrows(() => scanner.finish(), "unclosed multipart must throw");
  }],

  ["streaming: nested multipart missing inner closing boundary fails", () => {
    const email = mail([
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
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    assertThrows(() => {
      scanner.write(email);
      scanner.finish();
    }, "inner multipart unclosed must throw");
  }],

  ["streaming: input ending inside nested multipart fails at finish", () => {
    const email = mail([
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
    const scanner = createScanner([{ id: "kw", needle: KEYWORD, weight: 80 }]);
    scanner.write(email);
    assertThrows(() => scanner.finish(), "outer multipart unclosed must throw");
  }],
];

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScanner, type Rule } from "../src/scanner.js";
import {
  base64Lines,
  bytes,
  fixedChunks,
  qpEncode,
  runScan,
  singleBytes,
  splitAt,
  whole,
  type RunOutcome,
} from "./helpers.js";

/** 对同一封邮件验证：整体、每个字节位置两段切分、单字节切块，结果一致。 */
function assertChunkingInvariant(
  message: Uint8Array,
  rules: Rule[],
  expected: RunOutcome,
): void {
  const baseline = runScan(message, rules, whole(message));
  assert.deepEqual(baseline, expected, "whole-message run");

  for (let k = 0; k <= message.length; k++) {
    const outcome = runScan(message, rules, splitAt(message, k));
    assert.deepEqual(outcome, expected, `two-part split at byte ${k}`);
  }

  const bytewise = runScan(message, rules, singleBytes(message));
  assert.deepEqual(bytewise, expected, "single-byte chunks");
}

// 场景一：折叠首部 + 带引号 boundary + 嵌套 multipart，
// base64 与 quoted-printable 叶子解码出相同的 UTF-8 关键词。
const KEYWORD = "机密keyword";
const QP_ONLY = "QP尾部标记";

const RULES_1: Rule[] = [
  { id: "kw", needle: KEYWORD, weight: 40 },
  { id: "qp-only", needle: QP_ONLY, weight: 35 },
];

function buildMessage1(): Uint8Array {
  const b64Body = base64Lines(`前缀${KEYWORD}后缀`);
  // QP 正文中在关键词的多字节序列中间插入软换行。
  const qpBody =
    qpEncode("QP前缀") +
    "=E6=9C=\r\n=BA" + // “机” 的 UTF-8 序列被软换行截断
    qpEncode("密keyword") +
    qpEncode(QP_ONLY) +
    qpEncode("结尾");
  const text = [
    "From: alice@example.com",
    "Subject: folded",
    " \tsubject continues",
    "Content-Type: multipart/mixed;",
    "\tboundary=\"outer-boundary\"",
    "",
    "This is the preamble, ignored.",
    "--outer-boundary",
    "Content-Type: multipart/alternative; boundary=\"in\\\"ner\"",
    "",
    "--in\"ner",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: BASE64",
    "",
    b64Body,
    "--in\"ner",
    "content-type: TEXT/PLAIN; Charset=utf-8",
    "Content-Transfer-Encoding: Quoted-Printable",
    "",
    qpBody,
    "--in\"ner--",
    "--outer-boundary--",
    "trailing epilogue, ignored",
    "",
  ].join("\r\n");
  return bytes(text);
}

test("场景一：嵌套 multipart 中 base64 与 QP 叶子解码出相同关键词", () => {
  const message = buildMessage1();
  const expected: RunOutcome = {
    // kw 只在第一个叶子命中时报告一次；QP 叶子中的同一关键词不重复报告。
    writeHits: ["kw", "qp-only"],
    result: {
      hitIds: ["kw", "qp-only"],
      score: 75,
      quarantined: true,
    },
  };
  assertChunkingInvariant(message, RULES_1, expected);
});

test("场景一：命中不重复、计分为不同规则 weight 之和", () => {
  const message = buildMessage1();
  const { writeHits, result } = runScan(message, RULES_1, whole(message));
  assert.equal(new Set(writeHits).size, writeHits.length, "no duplicate hits");
  assert.equal(result.score, 40 + 35);
});

// 场景二：假边界前缀、解码后才出现的完整边界、被忽略的二进制分部、
// 跨叶子的关键词片段。
const RULES_2: Rule[] = [
  { id: "split", needle: "secret-key", weight: 10 },
  { id: "alpha", needle: "KEYWORD_ALPHA", weight: 10 },
  { id: "beta", needle: "KEYWORD_BETA", weight: 10 },
  { id: "gamma", needle: "KEYWORD_GAMMA", weight: 10 },
  { id: "delta", needle: "KEYWORD_DELTA", weight: 10 },
];

function buildMessage2(): Uint8Array {
  // 解码后包含完整边界文本 "\r\n--boundary\r\n"，但原始报文中不存在。
  const b64Body = base64Lines("前段\r\n--boundary\r\n后段 KEYWORD_BETA 尾");
  const binaryBody = Buffer.from("二进制 KEYWORD_GAMMA 不应扫描", "utf8").toString(
    "base64",
  );
  const text = [
    "Content-Type: multipart/mixed; boundary=boundary",
    "",
    "--boundary",
    "Content-Type: text/plain",
    "",
    "第一行",
    "--boundaryX 只是相同前缀，不是边界",
    "--boundary- 单个连字符也不是",
    "--boundar",
    "KEYWORD_ALPHA 在假边界之后仍被扫描 secr",
    "--boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Body,
    "--boundary",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    "",
    binaryBody,
    "--boundary",
    "Content-Type: text/plain",
    "",
    "et-key 开头补齐片段 KEYWORD_DELTA",
    "--boundary--",
    "",
  ].join("\r\n");
  return bytes(text);
}

test("场景二：假边界、解码边界、二进制分部与跨叶子片段", () => {
  const message = buildMessage2();
  const expected: RunOutcome = {
    writeHits: ["alpha", "beta", "delta"],
    result: {
      hitIds: ["alpha", "beta", "delta"],
      score: 30,
      quarantined: false,
    },
  };
  assertChunkingInvariant(message, RULES_2, expected);
});

// 场景三：20 MiB 长正文叶子，关键词在前段，write 在邮件结束前报告命中；
// 缺少关闭边界的版本 finish 必须失败。
const BIG_SIZE = 20 * 1024 * 1024;
const RULES_3: Rule[] = [{ id: "big", needle: "BIGKEYWORD", weight: 80 }];

function buildMessage3(closeBoundary: boolean): Uint8Array {
  const head = bytes(
    "Content-Type: multipart/mixed; boundary=bigboundary\r\n" +
      "\r\n" +
      "--bigboundary\r\n" +
      "Content-Type: text/plain\r\n" +
      "\r\n" +
      "BIGKEYWORD 随后是长正文\r\n",
  );
  const filler = new Uint8Array(BIG_SIZE).fill(0x78); // 'x'
  const tail = closeBoundary
    ? bytes("\r\n--bigboundary--\r\n")
    : new Uint8Array(0);
  const message = new Uint8Array(head.length + filler.length + tail.length);
  message.set(head, 0);
  message.set(filler, head.length);
  message.set(tail, head.length + filler.length);
  return message;
}

test("场景三：20 MiB 正文，write 在邮件结束前报告命中", () => {
  const message = buildMessage3(true);
  const scanner = createScanner(RULES_3);
  const chunks = fixedChunks(message, 64 * 1024);
  let hitAtChunk = -1;
  for (let i = 0; i < chunks.length; i++) {
    const hits = scanner.write(chunks[i]!);
    if (hits.length > 0 && hitAtChunk < 0) {
      assert.deepEqual(hits, ["big"]);
      hitAtChunk = i;
    } else if (hits.length > 0) {
      assert.fail("duplicate hit reported");
    }
  }
  assert.ok(hitAtChunk >= 0, "hit reported during write");
  assert.ok(hitAtChunk < chunks.length - 1, "hit reported well before input ends");
  const result = scanner.finish();
  assert.deepEqual(result, {
    hitIds: ["big"],
    score: 80,
    quarantined: true,
  });
});

test("场景三：缺少关闭边界的 multipart，finish 失败", () => {
  const message = buildMessage3(false);
  const scanner = createScanner(RULES_3);
  for (const chunk of fixedChunks(message, 1024 * 1024)) {
    scanner.write(chunk);
  }
  assert.throws(() => scanner.finish(), /not closed/);
});

// 基础行为：规则校验、大小写敏感、分数上限、空 chunk。
test("规则校验：重复 id、空 needle、非法 weight 均抛错", () => {
  assert.throws(() =>
    createScanner([
      { id: "a", needle: "x", weight: 1 },
      { id: "a", needle: "y", weight: 1 },
    ]),
  );
  assert.throws(() => createScanner([{ id: "a", needle: "", weight: 1 }]));
  assert.throws(() => createScanner([{ id: "a", needle: "x", weight: 0 }]));
  assert.throws(() => createScanner([{ id: "a", needle: "x", weight: 1.5 }]));
  assert.throws(() => createScanner([{ id: "a", needle: "x", weight: -2 }]));
});

test("匹配大小写敏感", () => {
  const message = bytes("Content-Type: text/plain\r\n\r\nsecret SECRET Secret");
  const { result } = runScan(
    message,
    [{ id: "s", needle: "Secret", weight: 10 }],
    whole(message),
  );
  assert.deepEqual(result.hitIds, ["s"]);
  const miss = runScan(
    message,
    [{ id: "s2", needle: "seCret", weight: 10 }],
    whole(message),
  );
  assert.deepEqual(miss.result.hitIds, []);
  assert.equal(miss.result.score, 0);
  assert.equal(miss.result.quarantined, false);
});

test("分数上限 100，阈值为 70", () => {
  const message = bytes("Content-Type: text/plain\r\n\r\naa bb cc");
  const rules: Rule[] = [
    { id: "a", needle: "aa", weight: 60 },
    { id: "b", needle: "bb", weight: 60 },
    { id: "c", needle: "cc", weight: 60 },
  ];
  const { result } = runScan(message, rules, whole(message));
  assert.equal(result.score, 100);
  assert.equal(result.quarantined, true);

  const below = runScan(bytes("Content-Type: text/plain\r\n\r\naa"), rules, whole(
    bytes("Content-Type: text/plain\r\n\r\naa"),
  ));
  assert.equal(below.result.score, 60);
  assert.equal(below.result.quarantined, false);
});

test("空 chunk 不改变扫描结果", () => {
  const message = bytes("Content-Type: text/plain\r\n\r\nhello KEYWORD world");
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 5 }];
  const empty = new Uint8Array(0);
  const chunks = [
    empty,
    message.subarray(0, 10),
    empty,
    message.subarray(10, 40),
    empty,
    message.subarray(40),
    empty,
  ];
  const withEmpties = runScan(message, rules, chunks);
  const baseline = runScan(message, rules, whole(message));
  assert.deepEqual(withEmpties, baseline);
});

test("缺省 Content-Type 视为 text/plain，缺省编码 7bit", () => {
  const message = bytes("From: a@b.c\r\n\r\nplain KEYWORD here");
  const { result } = runScan(
    message,
    [{ id: "k", needle: "KEYWORD", weight: 70 }],
    whole(message),
  );
  assert.deepEqual(result, { hitIds: ["k"], score: 70, quarantined: true });
});

test("finish 之后不能再 write", () => {
  const scanner = createScanner([{ id: "k", needle: "x", weight: 1 }]);
  scanner.write(bytes("Content-Type: text/plain\r\n\r\nx"));
  scanner.finish();
  assert.throws(() => scanner.write(bytes("more")));
});

// 边界与结构的边界情形。
test("关闭边界允许直接以输入结束收尾", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  for (const ending of ["--b--", "--b-- \t", "--b--\r", "--b--\r\n"]) {
    const message = bytes(
      `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nKEYWORD\r\n${ending}`,
    );
    const { result } = runScan(message, rules, whole(message));
    assert.deepEqual(result.hitIds, ["k"], `ending ${JSON.stringify(ending)}`);
  }
});

test("边界行允许空格/制表符填充", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  const message = bytes(
    "Content-Type: multipart/mixed; boundary=b\r\n" +
      "\r\n" +
      "--b \t \r\n" +
      "\r\n" +
      "KEYWORD\r\n" +
      "--b--\t \r\n",
  );
  const { result } = runScan(message, rules, whole(message));
  assert.deepEqual(result.hitIds, ["k"]);
});

test("multipart 前导与尾随说明文字不参与匹配", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  const message = bytes(
    "Content-Type: multipart/mixed; boundary=b\r\n" +
      "\r\n" +
      "preamble KEYWORD not scanned\r\n" +
      "--b\r\n" +
      "\r\n" +
      "body\r\n" +
      "--b--\r\n" +
      "epilogue KEYWORD not scanned\r\n",
  );
  const { result } = runScan(message, rules, whole(message));
  assert.deepEqual(result.hitIds, []);
});

test("multipart 嵌套最多 8 层", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  const build = (levels: number): Uint8Array => {
    let head = "";
    let tail = "";
    for (let i = 0; i < levels; i++) {
      head += `Content-Type: multipart/mixed; boundary=lv${i}\r\n\r\n--lv${i}\r\n`;
      tail = `\r\n--lv${i}--\r\n` + tail;
    }
    return bytes(`${head}Content-Type: text/plain\r\n\r\nKEYWORD${tail}`);
  };
  const ok = runScan(build(8), rules, whole(build(8)));
  assert.deepEqual(ok.result.hitIds, ["k"]);

  const scanner = createScanner(rules);
  assert.throws(() => {
    scanner.write(build(9));
    scanner.finish();
  }, /exceeds|nesting/);
});

test("分部首部超过 8 KiB 报错", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  const bigHeader = `X-Pad: ${"p".repeat(9 * 1024)}`;
  const message = bytes(
    `Content-Type: text/plain\r\n${bigHeader}\r\n\r\nKEYWORD`,
  );
  const scanner = createScanner(rules);
  assert.throws(() => scanner.write(message), /header/i);
});

test("8bit 编码的 UTF-8 叶子", () => {
  const rules: Rule[] = [{ id: "k", needle: "关键词", weight: 10 }];
  const message = bytes(
    "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Transfer-Encoding: 8bit\r\n" +
      "\r\n" +
      "这是关键词正文",
  );
  for (let k = 0; k <= message.length; k++) {
    const { result } = runScan(message, rules, splitAt(message, k));
    assert.deepEqual(result.hitIds, ["k"], `split at ${k}`);
  }
});

test("空分部与无首部分部", () => {
  const rules: Rule[] = [{ id: "k", needle: "KEYWORD", weight: 10 }];
  const message = bytes(
    "Content-Type: multipart/mixed; boundary=b\r\n" +
      "\r\n" +
      "--b\r\n" +
      "\r\n" +
      "\r\n" +
      "--b\r\n" +
      "\r\n" +
      "KEYWORD\r\n" +
      "--b--\r\n",
  );
  const { result } = runScan(message, rules, whole(message));
  assert.deepEqual(result.hitIds, ["k"]);
});

test("分隔行之前的 CRLF 属于分隔符，不属于正文", () => {
  // 正文为 "line1\r\nline2"，边界前的 CRLF 不进入正文。
  const message = bytes(
    "Content-Type: multipart/mixed; boundary=b\r\n" +
      "\r\n" +
      "--b\r\n" +
      "\r\n" +
      "line1\r\nline2\r\n" +
      "--b--\r\n",
  );
  const across = runScan(
    message,
    [{ id: "n", needle: "line1\r\nline2", weight: 10 }],
    whole(message),
  );
  assert.deepEqual(across.result.hitIds, ["n"], "正文内部换行保留且可跨行匹配");
  const trailing = runScan(
    message,
    [{ id: "n", needle: "line2\r\n", weight: 10 }],
    whole(message),
  );
  assert.deepEqual(trailing.result.hitIds, [], "边界前的 CRLF 不属于正文");
});

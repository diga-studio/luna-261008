import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createChecker, loadChecker, type MatchHit } from "../src/index.js";

/** 按词条分组统计命中次数。 */
function countByWord(hits: MatchHit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    counts.set(hit.word, (counts.get(hit.word) ?? 0) + 1);
  }
  return counts;
}

describe("跨格式节点与重叠词条", () => {
  it("敏感词横跨强调与链接标签，重叠词条全部命中", () => {
    const checker = createChecker(["彩票", "票网", "赌博"]);
    //            0   123 4 5 6 7 8...........31 32 33 3435 36
    const content = "买**彩[票](https://example.com/赌博)网**站";
    const hits = checker.check(content);

    expect(countByWord(hits)).toEqual(new Map([["彩票", 1], ["票网", 1]]));

    const lottery = hits.find((h) => h.word === "彩票")!;
    expect(lottery.ranges).toEqual([
      { start: 3, end: 4 }, // 彩（强调内）
      { start: 5, end: 6 }, // 票（链接标签内）
    ]);

    const overlap = hits.find((h) => h.word === "票网")!;
    expect(overlap.ranges).toEqual([
      { start: 5, end: 6 }, // 票
      { start: 31, end: 32 }, // 网
    ]);
  });

  it("链接地址不产生命中", () => {
    const checker = createChecker(["赌博", "example"]);
    const hits = checker.check("[点这里](https://example.com/赌博)");
    expect(hits).toEqual([]);
  });

  it("行内代码不产生命中，且作为边界阻断拼接", () => {
    const checker = createChecker(["彩票", "彩网"]);
    expect(checker.check("`彩票`")).toEqual([]);
    // 行内代码两侧的文字不能拼成命中。
    expect(checker.check("彩`x`票")).toEqual([]);
    // 代码之外的正常命中不受影响。
    const hits = checker.check("说`彩票`彩票");
    expect(hits).toHaveLength(1);
    expect(hits[0].ranges).toEqual([{ start: 5, end: 7 }]);
  });

  it("围栏代码块不产生命中，且作为边界", () => {
    const checker = createChecker(["赌博", "前后"]);
    const content = "前\n```\n赌博\n```\n后";
    const hits = checker.check(content);
    expect(hits).toEqual([]);
  });

  it("段落与换行是匹配边界", () => {
    const checker = createChecker(["赌博"]);
    expect(checker.check("赌\n博")).toEqual([]);
    expect(checker.check("赌\n\n博")).toEqual([]);
    expect(checker.check("赌  \n博")).toEqual([]);
  });

  it("同一词条的每次出现都返回", () => {
    const checker = createChecker(["abc"]);
    const hits = checker.check("abc abc");
    expect(hits).toHaveLength(2);
    expect(hits[0].ranges).toEqual([{ start: 0, end: 3 }]);
    expect(hits[1].ranges).toEqual([{ start: 4, end: 7 }]);
  });

  it("归一化后相同的不同词条各自命中，不因区间相同而去重", () => {
    const checker = createChecker(["abc", "ABC", "ＡＢＣ"]);
    const hits = checker.check("abc");
    expect(hits).toHaveLength(3);
    expect(countByWord(hits)).toEqual(
      new Map([["abc", 1], ["ABC", 1], ["ＡＢＣ", 1]]),
    );
    for (const hit of hits) {
      expect(hit.ranges).toEqual([{ start: 0, end: 3 }]);
    }
  });

  it("可见文字相同则命中词条与次数相同，与格式包装无关", () => {
    const checker = createChecker(["彩票", "票网", "网站"]);
    const plain = countByWord(checker.check("买彩票网站"));
    const rich = countByWord(checker.check("买**彩[票](https://a.b)网**站"));
    const richer = countByWord(checker.check("买**彩*票*网**站"));
    expect(rich).toEqual(plain);
    expect(richer).toEqual(plain);
    expect(plain).toEqual(new Map([["彩票", 1], ["票网", 1], ["网站", 1]]));
  });
});

describe("字素簇与归一化", () => {
  it("基础字母与组合音标被格式节点隔开仍属同一字素簇", () => {
    const checker = createChecker(["é", "café"]);
    //            0123 4 5  6
    const content = "cafe*́*";
    const hits = checker.check(content);
    expect(countByWord(hits)).toEqual(new Map([["é", 1], ["café", 1]]));
    const cafe = hits.find((h) => h.word === "café")!;
    expect(cafe.ranges).toEqual([
      { start: 0, end: 4 }, // cafe
      { start: 5, end: 6 }, // 组合音标（不含两侧的 *）
    ]);
    const e = hits.find((h) => h.word === "é")!;
    expect(e.ranges).toEqual([
      { start: 3, end: 4 }, // e
      { start: 5, end: 6 }, // 组合音标
    ]);
  });

  it("全角字符归一化后命中：ＡbＣ 命中 abc", () => {
    const checker = createChecker(["abc"]);
    const hits = checker.check("ＡbＣ");
    expect(hits).toHaveLength(1);
    expect(hits[0].ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it("单字符展开命中时覆盖整个原字符：ﬁ 命中 i 与 fi", () => {
    const checker = createChecker(["i", "fi", "ﬁ"]);
    const hits = checker.check("ﬁ");
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.ranges).toEqual([{ start: 0, end: 1 }]);
    }
  });

  it("实体按 CommonMark 解码后参与匹配，区间覆盖完整实体", () => {
    const checker = createChecker(["abc", "&"]);
    //            0 1.....6 7
    const hits = checker.check("a&#98;c");
    expect(countByWord(hits)).toEqual(new Map([["abc", 1]]));
    expect(hits[0].ranges).toEqual([{ start: 0, end: 7 }]);

    const amp = checker.check("&amp;");
    expect(amp).toHaveLength(1);
    expect(amp[0].word).toBe("&");
    expect(amp[0].ranges).toEqual([{ start: 0, end: 5 }]);
  });

  it("转义字符按 CommonMark 解码，区间覆盖完整转义序列", () => {
    const checker = createChecker(["a*b", "ab"]);
    //            0 12 3
    const content = "a\\*b";
    const hits = checker.check(content);
    // 可见文字是 a*b：a*b 命中，ab 不命中。
    expect(countByWord(hits)).toEqual(new Map([["a*b", 1]]));
    expect(hits[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("不可见字符被忽略且不进入命中区间", () => {
    const checker = createChecker(["赌博"]);
    //            0 1     2     3 4
    const content = "赌​‌‍﻿博";
    const hits = checker.check(content);
    expect(hits).toHaveLength(1);
    expect(hits[0].ranges).toEqual([
      { start: 0, end: 1 }, // 赌
      { start: 5, end: 6 }, // 博（中间的不可见字符不被框入）
    ]);
  });

  it("代理对不被切断", () => {
    const checker = createChecker(["😀", "abc"]);
    const hits = checker.check("😀abc");
    expect(countByWord(hits)).toEqual(new Map([["😀", 1], ["abc", 1]]));
    const emoji = hits.find((h) => h.word === "😀")!;
    expect(emoji.ranges).toEqual([{ start: 0, end: 2 }]);
    const abc = hits.find((h) => h.word === "abc")!;
    expect(abc.ranges).toEqual([{ start: 2, end: 5 }]);
  });
});

describe("词库加载", () => {
  const dir = join(tmpdir(), "moderation-test");

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("从本地文件加载词库，忽略空行与注释", async () => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `words-${Date.now()}.txt`);
    await writeFile(file, "# 注释\n\n赌博\n彩票\n\n", "utf8");
    const checker = await loadChecker(file);
    const hits = checker.check("赌博与彩票");
    expect(countByWord(hits)).toEqual(new Map([["赌博", 1], ["彩票", 1]]));
    expect(hits[0].ranges).toEqual([{ start: 0, end: 2 }]);
    expect(hits[1].ranges).toEqual([{ start: 3, end: 5 }]);
  });
});

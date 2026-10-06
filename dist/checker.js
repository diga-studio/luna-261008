import { readFile } from "node:fs/promises";
import { extractVisibleBlocks } from "./markdown.js";
import { Matcher } from "./matcher.js";
import { graphemeSpans, normalizeCluster, normalizeWord } from "./normalize.js";
/** 合并重叠或紧邻的区间；输入必须已按 start 升序。 */
function mergeRanges(ranges) {
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
        }
        else {
            merged.push({ start: range.start, end: range.end });
        }
    }
    return merged;
}
/** 在一个可见文字块上执行匹配，返回该块内的全部命中。 */
function matchBlock(block, matcher, words) {
    const atoms = block.atoms;
    const visibleText = atoms.map((atom) => atom.char).join("");
    // atoms 与 visibleText 的码点一一对应；预计算每个 atom 在 visibleText 中的 UTF-16 起点。
    const atomOffsets = new Array(atoms.length);
    {
        let offset = 0;
        atoms.forEach((atom, i) => {
            atomOffsets[i] = offset;
            offset += atom.char.length;
        });
    }
    // 逐扩展字素簇归一化，并记录归一化文本中每个 UTF-16 单元所属的簇，
    // 以及每个簇覆盖的 atom 下标区间。
    const clusters = graphemeSpans(visibleText);
    let normalizedText = "";
    const normToCluster = [];
    const clusterAtomSpan = [];
    let atomCursor = 0;
    clusters.forEach((span, clusterIndex) => {
        const normalized = normalizeCluster(visibleText.slice(span.start, span.end));
        for (let i = 0; i < normalized.length; i += 1) {
            normToCluster.push(clusterIndex);
        }
        normalizedText += normalized;
        const start = atomCursor;
        while (atomCursor < atoms.length && atomOffsets[atomCursor] < span.end) {
            atomCursor += 1;
        }
        clusterAtomSpan.push({ start, end: atomCursor });
    });
    const hits = [];
    for (const hit of matcher.findAll(normalizedText)) {
        const firstCluster = normToCluster[hit.start];
        const lastCluster = normToCluster[hit.end - 1];
        // 命中覆盖的所有簇：簇内任何可见码点被命中，整个簇的原文区间都计入。
        const ranges = [];
        for (let cluster = firstCluster; cluster <= lastCluster; cluster += 1) {
            const span = clusterAtomSpan[cluster];
            for (let i = span.start; i < span.end; i += 1) {
                ranges.push({ start: atoms[i].start, end: atoms[i].end });
            }
        }
        hits.push({ word: words[hit.wordIndex], ranges: mergeRanges(ranges) });
    }
    return hits;
}
/** 由词条数组创建检查器（词条为纯文本，不解释为 Markdown）。 */
export function createChecker(words) {
    // 去掉完全重复的词条，保留各自不同的写法（归一化相同也算不同词条）。
    const entries = [...new Set(words)];
    const matcher = new Matcher(entries.map((word, wordIndex) => ({ wordIndex, normalized: normalizeWord(word) })));
    return {
        check(content) {
            const hits = [];
            for (const block of extractVisibleBlocks(content)) {
                hits.push(...matchBlock(block, matcher, entries));
            }
            hits.sort((a, b) => a.ranges[0].start - b.ranges[0].start || a.word.localeCompare(b.word));
            return hits;
        },
    };
}
/** 从本地文件加载词库并创建检查器。每行一个词条，空行与 # 开头的行被忽略。 */
export async function loadChecker(wordlistPath) {
    const raw = await readFile(wordlistPath, "utf8");
    const words = raw
        .replace(/^﻿/, "")
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    return createChecker(words);
}

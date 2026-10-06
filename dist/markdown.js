/**
 * Markdown 可见文字抽取。
 *
 * 依据 CommonMark 0.31.2 解析（经由 micromark），把输入切分为若干“可见文字块”：
 * 强调内容与链接标签参与匹配；链接地址、行内代码、围栏代码块不参与。
 * 段落、可见文本中的换行、行内/围栏代码均为匹配边界，边界两侧不拼接。
 *
 * 每个可见码点携带其在原文中的半开区间（UTF-16 代码单元）：
 * 转义与实体解码出的字符覆盖该转义/实体的完整原文范围；
 * 被忽略的不可见字符在此直接丢弃，不留下位置。
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { decodeHTMLStrict } from "entities";
import { isIgnoredCodePoint } from "./normalize.js";
// CommonMark：十进制 1–7 位、十六进制 1–6 位、命名实体为 HTML5 实体名（最长 31 字符）。
const ENTITY_RE = /^&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
const ASCII_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
/** 从 Markdown 原文中抽取全部可见文字块。 */
export function extractVisibleBlocks(source) {
    const tree = fromMarkdown(source);
    const blocks = [];
    let current = [];
    const flush = () => {
        if (current.length > 0) {
            blocks.push({ atoms: current });
            current = [];
        }
    };
    const pushChar = (char, start, end) => {
        if (!isIgnoredCodePoint(char.codePointAt(0))) {
            current.push({ char, start, end });
        }
    };
    // 把一个 text 节点的原始源码切片重新切词为可见码点序列，
    // 并用节点已解码的 value 校验切词结果，保证位置映射可靠。
    const tokenizeTextNode = (raw, base, expected) => {
        let i = 0;
        let reconstructed = "";
        while (i < raw.length) {
            const ch = raw[i];
            if (ch === "\n" || ch === "\r") {
                flush();
                reconstructed += ch;
                i += 1;
                continue;
            }
            if (ch === "\\" && i + 1 < raw.length && ASCII_PUNCTUATION.has(raw[i + 1])) {
                pushChar(raw[i + 1], base + i, base + i + 2);
                reconstructed += raw[i + 1];
                i += 2;
                continue;
            }
            if (ch === "&") {
                const match = ENTITY_RE.exec(raw.slice(i, i + 40));
                if (match) {
                    const decoded = decodeHTMLStrict(match[0]);
                    if (decoded !== match[0]) {
                        for (const decodedChar of decoded) {
                            pushChar(decodedChar, base + i, base + i + match[0].length);
                        }
                        reconstructed += decoded;
                        i += match[0].length;
                        continue;
                    }
                }
            }
            const char = String.fromCodePoint(raw.codePointAt(i));
            pushChar(char, base + i, base + i + char.length);
            reconstructed += char;
            i += char.length;
        }
        if (reconstructed !== expected) {
            throw new Error(`text node decoding mismatch: ${JSON.stringify(reconstructed)} !== ${JSON.stringify(expected)}`);
        }
    };
    const walkInline = (nodes) => {
        for (const node of nodes) {
            switch (node.type) {
                case "text": {
                    const start = node.position?.start.offset;
                    const end = node.position?.end.offset;
                    if (start === undefined || end === undefined) {
                        throw new Error("parser did not provide node positions");
                    }
                    tokenizeTextNode(source.slice(start, end), start, node.value);
                    break;
                }
                case "emphasis":
                case "strong":
                case "link":
                case "linkReference":
                    // 强调内容与链接标签参与匹配，标记本身不产生可见字符。
                    walkInline(node.children);
                    break;
                default:
                    // 行内代码、硬换行及其他行内节点：匹配边界。
                    flush();
            }
        }
    };
    const walkBlock = (nodes) => {
        for (const node of nodes) {
            if (node.type === "paragraph" || node.type === "heading") {
                flush();
                walkInline(node.children);
                flush();
            }
            else if ("children" in node) {
                flush();
                walkBlock(node.children);
                flush();
            }
            else {
                // 围栏代码块、 thematic break、html 等：匹配边界，内容不参与。
                flush();
            }
        }
    };
    walkBlock(tree.children);
    flush();
    return blocks;
}

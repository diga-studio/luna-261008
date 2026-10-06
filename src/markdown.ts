import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import { characterEntities } from 'character-entities';
import type { SourceChar } from './normalize.js';

const parser = unified().use(remarkParse);

const ASCII_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

/**
 * Extract visible-text segments from CommonMark source.
 *
 * Each segment is a run of decoded visible characters (with original source
 * ranges) that participates in matching as one contiguous string. Segments
 * are split at every matching boundary: paragraphs, line breaks inside
 * visible text, and code regions (inline code / fenced code blocks). Code
 * contents and link destinations never appear in any segment.
 */
export function extractSegments(source: string): SourceChar[][] {
  const tree = parser.parse(source) as Root;
  const segments: SourceChar[][] = [];
  let current: SourceChar[] = [];

  const flush = () => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  const emit = (char: string, start: number, end: number) => {
    current.push({ char, range: { start, end } });
  };

  /** Decode a text node's raw source slice into visible characters. */
  const decodeText = (start: number, end: number) => {
    let i = start;
    while (i < end) {
      const ch = source[i];
      // Backslash escape: only before ASCII punctuation.
      if (ch === '\\' && i + 1 < end && ASCII_PUNCTUATION.has(source[i + 1])) {
        emit(source[i + 1], i, i + 2);
        i += 2;
        continue;
      }
      // Character reference (named or numeric).
      if (ch === '&') {
        const entity = matchEntity(source, i, end);
        if (entity !== null) {
          for (const char of entity.value) emit(char, i, entity.end);
          i = entity.end;
          continue;
        }
      }
      // Line ending: a matching boundary. Trailing whitespace of the line
      // and leading whitespace of the continuation line are not visible.
      if (ch === '\n' || ch === '\r') {
        while (current.length > 0 && /[ \t]/.test(current[current.length - 1].char)) {
          current.pop();
        }
        flush();
        i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
        while (i < end && (source[i] === ' ' || source[i] === '\t')) i++;
        continue;
      }
      const cp = source.codePointAt(i)!;
      const char = String.fromCodePoint(cp);
      emit(char, i, i + char.length);
      i += char.length;
    }
  };

  const walkInline = (nodes: readonly PhrasingContent[]) => {
    for (const node of nodes) {
      switch (node.type) {
        case 'text': {
          const pos = (node as { position?: { start: { offset?: number }; end: { offset?: number } } }).position;
          if (pos?.start.offset === undefined || pos.end.offset === undefined) break;
          decodeText(pos.start.offset, pos.end.offset);
          break;
        }
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
        case 'linkReference':
          walkInline(node.children);
          break;
        // Matching boundaries whose content is never visible text.
        case 'inlineCode':
        case 'break':
        case 'html':
        case 'image':
        case 'imageReference':
        case 'footnoteReference':
          flush();
          break;
        default:
          flush();
          break;
      }
    }
  };

  const walkBlock = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          walkInline(node.children as PhrasingContent[]);
          flush();
          break;
        case 'blockquote':
        case 'list':
        case 'listItem':
        case 'footnoteDefinition':
          walkBlock(node.children as RootContent[]);
          break;
        // Code blocks, HTML blocks, thematic breaks, tables, ...: boundary.
        default:
          flush();
          break;
      }
    }
  };

  walkBlock(tree.children);
  flush();
  return segments;
}

interface EntityMatch {
  value: string;
  end: number;
}

/** Match a CommonMark character reference at `start` (source[start] === '&'). */
function matchEntity(source: string, start: number, limit: number): EntityMatch | null {
  if (source[start + 1] === '#') {
    let i = start + 2;
    let hex = false;
    if (source[i] === 'x' || source[i] === 'X') {
      hex = true;
      i++;
    }
    const digitsStart = i;
    const maxDigits = hex ? 6 : 7;
    const digitRe = hex ? /[0-9a-fA-F]/ : /[0-9]/;
    while (i < limit && i - digitsStart < maxDigits && digitRe.test(source[i])) i++;
    if (i === digitsStart || source[i] !== ';') return null;
    let cp = parseInt(source.slice(digitsStart, i), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { value: String.fromCodePoint(cp), end: i + 1 };
  }
  const nameMatch = /^&([0-9A-Za-z]{1,32});/.exec(source.slice(start, Math.min(limit, start + 35)));
  if (nameMatch === null) return null;
  const value = (characterEntities as Record<string, string>)[nameMatch[1]];
  if (value === undefined) return null;
  return { value, end: start + nameMatch[0].length };
}

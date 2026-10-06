import { parseHeaders, HEADER_LIMIT, type PartHeaders } from "./headers.js";

/** 叶子分部的字节消费者：接收仍带传输编码的原始正文字节。 */
export interface LeafHandler {
  push(bytes: Uint8Array): void;
  end(): void;
}

/** 叶子工厂：返回 null 表示忽略该叶子。 */
export type LeafFactory = (headers: PartHeaders) => LeafHandler | null;

/** 允许的最大 multipart 嵌套层数。 */
export const MAX_DEPTH = 8;

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const TAB = 0x09;
const DASH = 0x2d;

/** 边界候选行的最大缓冲（CRLF + "--" + 70 字符 boundary + "--" + 空白填充）。 */
const CANDIDATE_LIMIT = 2 + 2 + 70 + 2 + 1024;

/**
 * 单个分部的解析器：先累积首部（上限 8 KiB），
 * 然后按 Content-Type 分派到 multipart 分裂器、叶子处理器或忽略。
 */
class PartParser {
  private headerBuf: number[] | null = [];
  private leaf: LeafHandler | null = null;
  private splitter: BoundarySplitter | null = null;
  private ignore = false;

  constructor(
    private readonly factory: LeafFactory,
    private readonly depth: number,
  ) {}

  write(bytes: Uint8Array): void {
    let offset = 0;
    if (this.headerBuf !== null) {
      offset = this.consumeHeaders(bytes);
      if (offset < 0) {
        return;
      }
    }
    if (offset < bytes.length) {
      this.writeBody(bytes.subarray(offset));
    }
  }

  end(): void {
    if (this.headerBuf !== null) {
      // 输入在首部中结束：宽松处理，按已有首部收尾，正文为空。
      const raw = Uint8Array.from(this.headerBuf);
      this.headerBuf = null;
      this.dispatch(raw);
    }
    if (this.splitter !== null) {
      this.splitter.end();
    }
    if (this.leaf !== null) {
      this.leaf.end();
    }
  }

  /** 逐字节累积首部，返回正文起始偏移；首部未结束返回 -1。 */
  private consumeHeaders(bytes: Uint8Array): number {
    const buf = this.headerBuf!;
    for (let i = 0; i < bytes.length; i++) {
      buf.push(bytes[i]!);
      const n = buf.length;
      if (n === 2 && buf[0] === CR && buf[1] === LF) {
        // 空首部：首行即空行。
        const raw = Uint8Array.from(buf.slice(0, n - 2));
        this.headerBuf = null;
        this.dispatch(raw);
        return i + 1;
      }
      if (
        n >= 4 &&
        buf[n - 4] === CR &&
        buf[n - 3] === LF &&
        buf[n - 2] === CR &&
        buf[n - 1] === LF
      ) {
        const raw = Uint8Array.from(buf.slice(0, n - 4));
        this.headerBuf = null;
        this.dispatch(raw);
        return i + 1;
      }
      if (n > HEADER_LIMIT) {
        throw new Error(`header block exceeds ${HEADER_LIMIT} bytes`);
      }
    }
    return -1;
  }

  private dispatch(rawHeaders: Uint8Array): void {
    const headers = parseHeaders(rawHeaders);
    if (headers.mediaType.startsWith("multipart/")) {
      if (this.depth >= MAX_DEPTH) {
        throw new Error(`multipart nesting exceeds ${MAX_DEPTH} levels`);
      }
      this.splitter = new BoundarySplitter(
        headers.boundary!,
        this.factory,
        this.depth + 1,
      );
      return;
    }
    const leaf = this.factory(headers);
    if (leaf === null) {
      this.ignore = true;
    } else {
      this.leaf = leaf;
    }
  }

  private writeBody(bytes: Uint8Array): void {
    if (this.splitter !== null) {
      this.splitter.write(bytes);
    } else if (this.leaf !== null) {
      this.leaf.push(bytes);
    } else if (!this.ignore) {
      throw new Error("part body before headers");
    }
  }
}

/** 分裂器状态。 */
const enum S {
  /** 前导说明文字中，处于行首。 */
  PreambleLineStart,
  /** 前导说明文字中，跳过到行尾。 */
  PreambleSkip,
  /** 分部内容中。 */
  Body,
  /** 分部内容中，刚看到 CR。 */
  CrSeen,
  /** 正在匹配 "--boundary"。 */
  Match,
  /** 已匹配完 "--boundary"，等待后续判定。 */
  AfterDelim,
  /** 已看到 "--boundary-"，等待第二个 '-"。 */
  ClosingDash,
  /** 开放边界后的空白填充。 */
  PadOpen,
  /** 关闭边界后的空白填充。 */
  PadClose,
  /** 开放边界行尾，等待 LF。 */
  WaitLfOpen,
  /** 关闭边界行尾，等待 LF。 */
  WaitLfClose,
  /** 尾随说明文字，全部丢弃。 */
  Epilogue,
}

/**
 * multipart 边界分裂器。把输入流切成若干子分部，
 * 前导/尾随说明文字丢弃，边界行（含其前的 CRLF）不进入正文。
 */
class BoundarySplitter {
  private state: S = S.PreambleLineStart;
  private child: PartParser | null = null;
  private closed = false;
  /** 边界候选缓冲（不进入正文的待定字节）。 */
  private buf: number[] = [];
  private matchPos = 0;
  private readonly delim: number[];

  constructor(
    boundary: string,
    private readonly factory: LeafFactory,
    private readonly depth: number,
  ) {
    this.delim = [];
    for (const ch of "--" + boundary) {
      this.delim.push(ch.charCodeAt(0));
    }
  }

  write(bytes: Uint8Array): void {
    let i = 0;
    while (i < bytes.length) {
      switch (this.state) {
        case S.Body: {
          // 快速路径：把下一个 CR 之前的字节整块交给子分部。
          const b = bytes[i]!;
          if (b !== CR) {
            let end = i + 1;
            while (end < bytes.length && bytes[end] !== CR) {
              end += 1;
            }
            this.child!.write(bytes.subarray(i, end));
            i = end;
            continue;
          }
          this.buf = [CR];
          this.state = S.CrSeen;
          i += 1;
          continue;
        }
        case S.CrSeen: {
          const b = bytes[i]!;
          if (b === LF) {
            this.buf.push(LF);
            this.matchPos = 0;
            this.state = S.Match;
            i += 1;
          } else {
            // 孤立 CR：属于正文，重新按 Body 处理当前字节。
            this.flushBuf();
            this.state = S.Body;
          }
          continue;
        }
        case S.Match: {
          const b = bytes[i]!;
          if (b === this.delim[this.matchPos]) {
            this.buf.push(b);
            this.matchPos += 1;
            i += 1;
            if (this.matchPos === this.delim.length) {
              this.state = S.AfterDelim;
            }
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.AfterDelim: {
          const b = bytes[i]!;
          if (b === DASH) {
            this.buf.push(b);
            this.state = S.ClosingDash;
            i += 1;
          } else if (b === SP || b === TAB) {
            this.buf.push(b);
            this.state = S.PadOpen;
            i += 1;
          } else if (b === CR) {
            this.buf.push(b);
            this.state = S.WaitLfOpen;
            i += 1;
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.ClosingDash: {
          const b = bytes[i]!;
          if (b === DASH) {
            this.buf.push(b);
            this.state = S.PadClose;
            i += 1;
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.PadOpen:
        case S.PadClose: {
          const b = bytes[i]!;
          if (b === SP || b === TAB) {
            this.buf.push(b);
            i += 1;
            if (this.buf.length > CANDIDATE_LIMIT) {
              this.mismatch();
            }
          } else if (b === CR) {
            this.buf.push(b);
            this.state = this.state === S.PadOpen ? S.WaitLfOpen : S.WaitLfClose;
            i += 1;
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.WaitLfOpen: {
          const b = bytes[i]!;
          if (b === LF) {
            i += 1;
            this.openPart();
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.WaitLfClose: {
          const b = bytes[i]!;
          if (b === LF) {
            i += 1;
            this.closePart();
          } else {
            this.mismatch();
          }
          continue;
        }
        case S.PreambleLineStart: {
          this.buf = [];
          this.matchPos = 0;
          this.state = S.Match;
          continue;
        }
        case S.PreambleSkip: {
          const b = bytes[i]!;
          i += 1;
          if (b === LF) {
            this.state = S.PreambleLineStart;
          }
          continue;
        }
        case S.Epilogue: {
          return;
        }
      }
    }
  }

  end(): void {
    if (this.closed) {
      return;
    }
    // 关闭边界允许直接以输入结束收尾："--b--"（可加空白填充、可带 CR）。
    if (this.state === S.PadClose || this.state === S.WaitLfClose) {
      this.closePart();
      return;
    }
    throw new Error("multipart not closed: missing closing boundary");
  }

  /** 候选不是边界：缓冲字节回归正文（或前导丢弃）。 */
  private mismatch(): void {
    if (this.child !== null) {
      this.flushBuf();
      this.state = S.Body;
    } else {
      this.buf = [];
      this.state = S.PreambleSkip;
    }
  }

  private flushBuf(): void {
    if (this.buf.length > 0) {
      this.child!.write(Uint8Array.from(this.buf));
      this.buf = [];
    }
  }

  private openPart(): void {
    this.buf = [];
    if (this.child !== null) {
      this.child.end();
    }
    this.child = new PartParser(this.factory, this.depth);
    this.state = S.Body;
  }

  private closePart(): void {
    this.buf = [];
    if (this.child !== null) {
      this.child.end();
      this.child = null;
    }
    this.closed = true;
    this.state = S.Epilogue;
  }
}

/**
 * 流式 MIME 解析器。逐块接收原始报文字节，
 * 把每个非 multipart 叶子分部的原始正文字节交给工厂返回的处理器。
 * finish 时若 multipart 未闭合则抛错。
 */
export class MimeParser {
  private readonly root: PartParser;

  constructor(factory: LeafFactory) {
    this.root = new PartParser(factory, 0);
  }

  /** 喂入一块原始字节。 */
  write(bytes: Uint8Array): void {
    this.root.write(bytes);
  }

  /** 结束输入。 */
  finish(): void {
    this.root.end();
  }
}

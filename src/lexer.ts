/** 词法单元类别。 */
export type TokenKind = 'ident' | 'punct' | 'other';

/** 词法单元。字符串与注释内容不产生单元，直接被丢弃。 */
export interface Token {
  readonly kind: TokenKind;
  /**
   * ident：规范化文本（未引用标识符 ASCII 小写化；引用标识符还原成对双引号并保留大小写）。
   * punct：单个标点字符（( ) [ ] , ; . * 之一）。
   * other：空串。
   */
  readonly text: string;
  /** ident 是否来自双引号标识符。 */
  readonly quoted: boolean;
  /** 单元起始的绝对字节偏移。 */
  readonly offset: number;
}

export type TokenSink = (token: Token) => void;

type State =
  | 'default'
  | 'lineComment'
  | 'blockComment'
  | 'string'
  | 'estring'
  | 'dollarString'
  | 'dollarOpen'
  | 'quotedIdent';

const CH_SPACE = 0x20;
const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_VT = 0x0b;
const CH_FF = 0x0c;
const CH_SQUOTE = 0x27;
const CH_DQUOTE = 0x22;
const CH_MINUS = 0x2d;
const CH_SLASH = 0x2f;
const CH_STAR = 0x2a;
const CH_DOLLAR = 0x24;
const CH_BACKSLASH = 0x5c;
const CH_UNDERSCORE = 0x5f;

function isSpace(b: number): boolean {
  return (
    b === CH_SPACE || b === CH_TAB || b === CH_LF ||
    b === CH_CR || b === CH_VT || b === CH_FF
  );
}

function isIdentStart(b: number): boolean {
  return (
    b === CH_UNDERSCORE ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b >= 0x80
  );
}

function isIdentCont(b: number): boolean {
  return isIdentStart(b) || (b >= 0x30 && b <= 0x39) || b === CH_DOLLAR;
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function isTagStart(b: number): boolean {
  return (
    b === CH_UNDERSCORE ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a)
  );
}

function isTagChar(b: number): boolean {
  return isTagStart(b) || isDigit(b);
}

function isPunct(b: number): boolean {
  return (
    b === 0x28 || b === 0x29 || // ( )
    b === 0x5b || b === 0x5d || // [ ]
    b === 0x2c || // ,
    b === 0x3b || // ;
    b === 0x2e || // .
    b === CH_STAR // *
  );
}

/**
 * 流式 PostgreSQL 词法器。按字节处理，天然容忍多字节字符被分段切开。
 * 字符串与注释内容不落地保存，内存占用与输入大小无关。
 */
export class Lexer {
  private readonly sink: TokenSink;
  private readonly decoder = new TextDecoder();

  private state: State = 'default';
  private blockDepth = 0;

  // 未引用标识符累积（跨分段）
  private identActive = false;
  private identBuf: number[] = [];
  private identStart = 0;

  // 双引号标识符累积
  private quoteBuf: number[] = [];
  private quoteStart = 0;
  private quoteEnd = false;

  // 字符串结束引号待判定（可能是成对转义的第一个）
  private stringEnd = false;
  private escapePending = false;

  // 美元引号
  private dollarOpenBuf: number[] = [];
  private dollarOpenStart = 0;
  private dollarTag: number[] = [];
  private dollarMatch = 0;

  // 单字符操作符的跨分段待判定
  private minusPending = false;
  private minusPos = 0;
  private slashPending = false;
  private slashPos = 0;

  // other 单元合并
  private otherActive = false;
  private otherStart = 0;
  private otherEnd = 0;

  constructor(sink: TokenSink) {
    this.sink = sink;
  }

  /** 提交一段字节。 */
  push(chunk: Uint8Array): void {
    const base = this.nextOffset;
    for (let i = 0; i < chunk.length; i++) {
      this.processByte(chunk[i], base + i);
    }
    this.nextOffset = base + chunk.length;
  }

  private nextOffset = 0;

  /**
   * 结束事件。
   * @returns 输入是否干净结束（未处于字符串、引用标识符或块注释中）。
   */
  finish(): boolean {
    if (this.minusPending) {
      this.minusPending = false;
      this.emitOther(this.minusPos);
    }
    if (this.slashPending) {
      this.slashPending = false;
      this.emitOther(this.slashPos);
    }
    if (this.state === 'dollarOpen') {
      // EOF 前未闭合的 $tag：按普通字符重放，不属于未闭合构造。
      this.state = 'default';
      this.emitOther(this.dollarOpenStart);
      this.replayDollarOpen();
    }
    if (this.state === 'string' || this.state === 'estring') {
      if (this.stringEnd) {
        // 末尾引号即结束引号，字符串已闭合。
        this.stringEnd = false;
        this.state = 'default';
      } else {
        return false;
      }
    }
    if (this.state === 'quotedIdent') {
      if (this.quoteEnd) {
        this.quoteEnd = false;
        this.state = 'default';
        this.emitQuotedIdent();
      } else {
        return false;
      }
    }
    if (this.state === 'blockComment') return false;
    if (this.state === 'dollarString') return false;
    this.flushIdent();
    this.flushOther();
    return true;
  }

  private processByte(b: number, pos: number): void {
    if (this.minusPending) {
      this.minusPending = false;
      if (b === CH_MINUS) {
        this.flushIdent();
        this.flushOther();
        this.state = 'lineComment';
        return;
      }
      this.emitOther(this.minusPos);
    }
    if (this.slashPending) {
      this.slashPending = false;
      if (b === CH_STAR) {
        this.flushIdent();
        this.flushOther();
        this.state = 'blockComment';
        this.blockDepth = 1;
        return;
      }
      this.emitOther(this.slashPos);
    }
    switch (this.state) {
      case 'default':
        this.processDefault(b, pos);
        return;
      case 'lineComment':
        if (b === CH_LF) this.state = 'default';
        return;
      case 'blockComment':
        this.processBlockComment(b);
        return;
      case 'string':
      case 'estring':
        this.processString(b, pos);
        return;
      case 'dollarOpen':
        this.processDollarOpen(b, pos);
        return;
      case 'dollarString':
        this.processDollarString(b);
        return;
      case 'quotedIdent':
        this.processQuotedIdent(b, pos);
        return;
    }
  }

  private processDefault(b: number, pos: number): void {
    if (this.identActive) {
      if (isIdentCont(b)) {
        this.identBuf.push(b);
        return;
      }
      // E 前缀转义字符串：标识符恰好为单个 e/E 且紧随单引号。
      if (
        b === CH_SQUOTE && this.identBuf.length === 1 &&
        (this.identBuf[0] === 0x65 || this.identBuf[0] === 0x45)
      ) {
        this.identActive = false;
        this.identBuf.length = 0;
        this.flushOther();
        this.state = 'estring';
        this.stringEnd = false;
        this.escapePending = false;
        return;
      }
      this.flushIdent();
    }
    if (isSpace(b)) {
      this.flushOther();
      return;
    }
    if (b === CH_SQUOTE) {
      this.flushOther();
      this.state = 'string';
      this.stringEnd = false;
      return;
    }
    if (b === CH_DQUOTE) {
      this.flushOther();
      this.state = 'quotedIdent';
      this.quoteBuf = [];
      this.quoteStart = pos;
      this.quoteEnd = false;
      return;
    }
    if (b === CH_MINUS) {
      this.flushOther();
      this.minusPending = true;
      this.minusPos = pos;
      return;
    }
    if (b === CH_SLASH) {
      this.flushOther();
      this.slashPending = true;
      this.slashPos = pos;
      return;
    }
    if (b === CH_DOLLAR) {
      this.flushOther();
      this.state = 'dollarOpen';
      this.dollarOpenBuf = [];
      this.dollarOpenStart = pos;
      return;
    }
    if (isPunct(b)) {
      this.flushOther();
      this.sink({ kind: 'punct', text: String.fromCharCode(b), quoted: false, offset: pos });
      return;
    }
    if (isIdentStart(b)) {
      this.flushOther();
      this.identActive = true;
      this.identBuf = [b];
      this.identStart = pos;
      return;
    }
    this.emitOther(pos);
  }

  private processBlockComment(b: number): void {
    if (b === CH_STAR) {
      if (this.commentSlash) {
        this.blockDepth++;
        this.commentSlash = false;
      }
      this.commentStar = true;
      return;
    }
    if (b === CH_SLASH) {
      if (this.commentStar) {
        this.commentStar = false;
        this.blockDepth--;
        if (this.blockDepth === 0) this.state = 'default';
        return;
      }
      this.commentSlash = true;
      return;
    }
    this.commentStar = false;
    this.commentSlash = false;
  }

  private commentStar = false;
  private commentSlash = false;

  private processString(b: number, pos: number): void {
    if (this.state === 'estring') {
      if (this.escapePending) {
        this.escapePending = false;
        return;
      }
      if (b === CH_BACKSLASH) {
        this.escapePending = true;
        return;
      }
    }
    if (this.stringEnd) {
      if (b === CH_SQUOTE) {
        this.stringEnd = false;
        return;
      }
      this.stringEnd = false;
      this.state = 'default';
      this.processDefault(b, pos);
      return;
    }
    if (b === CH_SQUOTE) this.stringEnd = true;
  }

  private processDollarOpen(b: number, pos: number): void {
    if (b === CH_DOLLAR) {
      this.dollarTag = [CH_DOLLAR, ...this.dollarOpenBuf, CH_DOLLAR];
      this.dollarMatch = 0;
      this.state = 'dollarString';
      return;
    }
    const valid = this.dollarOpenBuf.length === 0 ? isTagStart(b) : isTagChar(b);
    if (valid) {
      this.dollarOpenBuf.push(b);
      return;
    }
    // 不是美元引号：$ 作为 other，已累积的标签字符重放。
    this.state = 'default';
    this.emitOther(this.dollarOpenStart);
    this.replayDollarOpen();
    this.processDefault(b, pos);
  }

  private replayDollarOpen(): void {
    const buf = this.dollarOpenBuf;
    const start = this.dollarOpenStart;
    this.dollarOpenBuf = [];
    for (let i = 0; i < buf.length; i++) {
      this.processDefault(buf[i], start + 1 + i);
    }
  }

  private processDollarString(b: number): void {
    if (b === this.dollarTag[this.dollarMatch]) {
      this.dollarMatch++;
      if (this.dollarMatch === this.dollarTag.length) {
        this.state = 'default';
        this.dollarMatch = 0;
      }
      return;
    }
    this.dollarMatch = b === CH_DOLLAR ? 1 : 0;
  }

  private processQuotedIdent(b: number, pos: number): void {
    if (this.quoteEnd) {
      if (b === CH_DQUOTE) {
        this.quoteBuf.push(CH_DQUOTE);
        this.quoteEnd = false;
        return;
      }
      this.quoteEnd = false;
      this.state = 'default';
      this.emitQuotedIdent();
      this.processDefault(b, pos);
      return;
    }
    if (b === CH_DQUOTE) {
      this.quoteEnd = true;
      return;
    }
    this.quoteBuf.push(b);
  }

  private emitQuotedIdent(): void {
    const text = this.decoder.decode(new Uint8Array(this.quoteBuf));
    this.flushOther();
    this.sink({ kind: 'ident', text, quoted: true, offset: this.quoteStart });
    this.quoteBuf = [];
  }

  private flushIdent(): void {
    if (!this.identActive) return;
    this.identActive = false;
    const bytes = this.identBuf;
    this.identBuf = [];
    // 仅 ASCII 大写转小写，其余字节原样保留。
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 0x41 && b <= 0x5a) bytes[i] = b + 0x20;
    }
    const text = this.decoder.decode(new Uint8Array(bytes));
    this.flushOther();
    this.sink({ kind: 'ident', text, quoted: false, offset: this.identStart });
  }

  private emitOther(pos: number): void {
    if (this.otherActive && this.otherEnd === pos) {
      this.otherEnd = pos + 1;
      return;
    }
    this.flushOther();
    this.otherActive = true;
    this.otherStart = pos;
    this.otherEnd = pos + 1;
  }

  private flushOther(): void {
    if (!this.otherActive) return;
    this.otherActive = false;
    this.sink({ kind: 'other', text: '', quoted: false, offset: this.otherStart });
  }
}

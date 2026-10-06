/** Token kinds produced by the streaming PostgreSQL lexer. */
export const enum TokenKind {
  Ident, // unquoted identifier/keyword, text is ASCII-lowercased
  QuotedIdent, // "..." identifier, text unescaped, case preserved
  Semi, // ;
  Comma, // ,
  LParen, // (
  RParen, // )
  LBracket, // [
  RBracket, // ]
  Dot, // .
  Star, // *
  Other, // operators, literals, anything else (strings/comments are consumed silently)
}

export interface Token {
  kind: TokenKind;
  /** Absolute UTF-8 byte offset of the token start. */
  start: number;
  /** Normalized text for Ident / QuotedIdent, otherwise undefined. */
  text?: string;
}

export type TokenSink = (token: Token) => void;

const enum State {
  Normal,
  Ident,
  MaybeE, // saw e/E in Normal; could be E'...' or an identifier
  MaybeDash, // saw '-'; could be '--' line comment
  MaybeSlash, // saw '/'; could be '/*' block comment
  LineComment,
  BlockComment,
  BlockCommentSlash, // saw '/' inside block comment
  BlockCommentStar, // saw '*' inside block comment
  String, // plain '...'
  StringQuote, // saw ' inside plain string
  EString, // E'...'
  EStringBackslash, // saw \ inside E string
  EStringQuote, // saw ' inside E string
  QuotedIdent, // "..."
  QuotedIdentQuote, // saw " inside quoted identifier
  DollarTag, // saw '$', collecting tag bytes
  DollarString, // inside $tag$ ... $tag$
}

const MAX_IDENT_BUF = 4096; // defensive cap; valid input stays <= 63
const MAX_TAG_BUF = 64; // valid dollar tags are <= 63 bytes

const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isIdentStart = (b: number) =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b >= 0x80;
const isIdentCont = (b: number) => isIdentStart(b) || isDigit(b) || b === 0x24; // $
const isTagChar = (b: number) =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || isDigit(b);
const isSpace = (b: number) =>
  b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;

/**
 * Incremental byte-level lexer. Accepts arbitrary Uint8Array fragments
 * (splits may fall inside multi-byte UTF-8 characters) and emits tokens
 * through the sink. String and comment bodies are consumed without being
 * buffered, so memory stays bounded regardless of input size.
 */
export class Lexer {
  private state: State = State.Normal;
  private pos = 0; // absolute byte offset of the next byte
  private readonly identBuf: number[] = [];
  private identStart = 0;
  private readonly tagBuf: number[] = [];
  private dollarStart = 0;
  private dollarMatched = 0; // bytes of the closing $tag$ sequence matched
  private commentDepth = 0;
  private otherStart = -1; // start of the current Other run, -1 = none
  private pendingPos = 0; // position of the pending '-' or '/'
  private readonly decoder = new TextDecoder();

  constructor(private readonly sink: TokenSink) {}

  /** Feed the next fragment of the event. */
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.handle(chunk[i]);
      this.pos++;
    }
  }

  /**
   * Signal end of event.
   * Returns true when every lexical structure was closed cleanly;
   * false when a string, quoted identifier or block comment is still open.
   */
  end(): boolean {
    switch (this.state) {
      case State.String:
      case State.EString:
      case State.EStringBackslash:
      case State.QuotedIdent:
      case State.BlockComment:
      case State.BlockCommentSlash:
      case State.BlockCommentStar:
      case State.DollarString:
        return false;
      case State.DollarTag:
        // A trailing '$tag' that never opened a string: not a dollar quote.
        this.failDollar(-1);
        this.flush();
        return true;
      default:
        this.flush();
        return true;
    }
  }

  /** Flush pending token(s) at end of input (or after dollar failure). */
  private flush(): void {
    switch (this.state) {
      case State.Ident:
        this.emitIdent();
        break;
      case State.MaybeE:
        this.identBuf.push(0x65); // "e"
        this.emitIdent();
        break;
      case State.StringQuote:
      case State.EStringQuote:
        this.state = State.Normal; // the quote closed the string
        break;
      case State.QuotedIdentQuote:
        this.emitQuotedIdent();
        break;
      default:
        break;
    }
    if (
      this.state === State.MaybeDash ||
      this.state === State.MaybeSlash
    ) {
      this.state = State.Normal;
    }
    this.flushOther();
  }

  private emit(kind: TokenKind, start: number, text?: string): void {
    this.sink(text === undefined ? { kind, start } : { kind, start, text });
  }

  private emitIdent(): void {
    const bytes = new Uint8Array(this.identBuf);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x41 && bytes[i] <= 0x5a) bytes[i] += 0x20;
    }
    this.emit(TokenKind.Ident, this.identStart, this.decoder.decode(bytes));
    this.identBuf.length = 0;
    this.state = State.Normal;
  }

  private emitQuotedIdent(): void {
    this.emit(
      TokenKind.QuotedIdent,
      this.identStart,
      this.decoder.decode(new Uint8Array(this.identBuf)),
    );
    this.identBuf.length = 0;
    this.state = State.Normal;
  }

  private flushOther(): void {
    if (this.otherStart >= 0) {
      this.emit(TokenKind.Other, this.otherStart);
      this.otherStart = -1;
    }
  }

  private startOther(at: number): void {
    if (this.otherStart < 0) this.otherStart = at;
  }

  /** A comment opens: keep the Other run up to the pending '-'/'/' byte. */
  private trimOtherBeforePending(): void {
    if (this.otherStart >= 0 && this.otherStart < this.pendingPos) {
      this.emit(TokenKind.Other, this.otherStart);
    }
    this.otherStart = -1;
  }

  /** Dollar-quote open failed: emit Other for '$' and re-lex tag bytes. */
  private failDollar(current: number): void {
    this.state = State.Normal;
    this.emit(TokenKind.Other, this.dollarStart);
    const saved = this.tagBuf.slice();
    this.tagBuf.length = 0;
    for (const b of saved) this.handle(b);
    if (current >= 0) this.handle(current);
  }

  private handle(b: number): void {
    let again = true;
    while (again) {
      again = false;
      switch (this.state) {
        case State.Normal:
          this.handleNormal(b);
          break;
        case State.Ident:
          if (isIdentCont(b)) {
            if (this.identBuf.length < MAX_IDENT_BUF) this.identBuf.push(b);
          } else {
            this.emitIdent();
            again = true;
          }
          break;
        case State.MaybeE:
          if (b === 0x27) {
            // E'...' escape string; the 'e' is not emitted.
            this.flushOther();
            this.state = State.EString;
          } else {
            this.identBuf.push(0x65);
            this.state = State.Ident;
            again = true;
          }
          break;
        case State.MaybeDash:
          if (b === 0x2d) {
            this.trimOtherBeforePending();
            this.state = State.LineComment;
          } else {
            this.state = State.Normal;
            again = true;
          }
          break;
        case State.MaybeSlash:
          if (b === 0x2a) {
            this.trimOtherBeforePending();
            this.commentDepth = 1;
            this.state = State.BlockComment;
          } else {
            this.state = State.Normal;
            again = true;
          }
          break;
        case State.LineComment:
          if (b === 0x0a) this.state = State.Normal;
          break;
        case State.BlockComment:
          if (b === 0x2f) this.state = State.BlockCommentSlash;
          else if (b === 0x2a) this.state = State.BlockCommentStar;
          break;
        case State.BlockCommentSlash:
          if (b === 0x2a) {
            this.commentDepth++;
            this.state = State.BlockComment;
          } else if (b !== 0x2f) {
            this.state = State.BlockComment;
          }
          break;
        case State.BlockCommentStar:
          if (b === 0x2f) {
            this.commentDepth--;
            this.state = this.commentDepth === 0 ? State.Normal : State.BlockComment;
          } else if (b !== 0x2a) {
            this.state = State.BlockComment;
          }
          break;
        case State.String:
          if (b === 0x27) this.state = State.StringQuote;
          break;
        case State.StringQuote:
          if (b === 0x27) this.state = State.String;
          else {
            this.state = State.Normal;
            again = true;
          }
          break;
        case State.EString:
          if (b === 0x5c) this.state = State.EStringBackslash;
          else if (b === 0x27) this.state = State.EStringQuote;
          break;
        case State.EStringBackslash:
          this.state = State.EString; // exactly one byte is escaped
          break;
        case State.EStringQuote:
          if (b === 0x27) this.state = State.EString;
          else {
            this.state = State.Normal;
            again = true;
          }
          break;
        case State.QuotedIdent:
          if (b === 0x22) this.state = State.QuotedIdentQuote;
          else if (this.identBuf.length < MAX_IDENT_BUF) this.identBuf.push(b);
          break;
        case State.QuotedIdentQuote:
          if (b === 0x22) {
            if (this.identBuf.length < MAX_IDENT_BUF) this.identBuf.push(0x22);
            this.state = State.QuotedIdent;
          } else {
            this.emitQuotedIdent();
            again = true;
          }
          break;
        case State.DollarTag:
          if (b === 0x24) {
            // '$' + tag + '$' opens a dollar-quoted string.
            this.state = State.DollarString;
            this.dollarMatched = 0;
          } else if (isTagChar(b) && (this.tagBuf.length > 0 || !isDigit(b))) {
            if (this.tagBuf.length < MAX_TAG_BUF) {
              this.tagBuf.push(b);
            } else {
              this.failDollar(-1); // tag too long: not a valid dollar quote
              again = true;
            }
          } else {
            this.failDollar(b);
          }
          break;
        case State.DollarString: {
          // Match the closing sequence '$' + tag + '$' with overlap support.
          const seq = this.tagBuf;
          let expected: number;
          if (this.dollarMatched === 0 || this.dollarMatched === seq.length + 1) {
            expected = 0x24; // '$'
          } else {
            expected = seq[this.dollarMatched - 1];
          }
          if (b === expected) {
            this.dollarMatched++;
            if (this.dollarMatched === seq.length + 2) this.state = State.Normal;
          } else {
            this.dollarMatched = b === 0x24 ? 1 : 0;
          }
          break;
        }
      }
    }
  }

  private handleNormal(b: number): void {
    switch (b) {
      case 0x3b: // ;
        this.flushOther();
        this.emit(TokenKind.Semi, this.pos);
        break;
      case 0x2c: // ,
        this.flushOther();
        this.emit(TokenKind.Comma, this.pos);
        break;
      case 0x28: // (
        this.flushOther();
        this.emit(TokenKind.LParen, this.pos);
        break;
      case 0x29: // )
        this.flushOther();
        this.emit(TokenKind.RParen, this.pos);
        break;
      case 0x5b: // [
        this.flushOther();
        this.emit(TokenKind.LBracket, this.pos);
        break;
      case 0x5d: // ]
        this.flushOther();
        this.emit(TokenKind.RBracket, this.pos);
        break;
      case 0x2e: // .
        this.flushOther();
        this.emit(TokenKind.Dot, this.pos);
        break;
      case 0x2a: // *
        this.flushOther();
        this.emit(TokenKind.Star, this.pos);
        break;
      case 0x27: // '
        this.flushOther();
        this.state = State.String;
        break;
      case 0x22: // "
        this.flushOther();
        this.identStart = this.pos;
        this.identBuf.length = 0;
        this.state = State.QuotedIdent;
        break;
      case 0x24: // $
        this.flushOther();
        this.dollarStart = this.pos;
        this.tagBuf.length = 0;
        this.state = State.DollarTag;
        break;
      case 0x2d: // -
        this.startOther(this.pos);
        this.pendingPos = this.pos;
        this.state = State.MaybeDash;
        break;
      case 0x2f: // /
        this.startOther(this.pos);
        this.pendingPos = this.pos;
        this.state = State.MaybeSlash;
        break;
      case 0x45: // E
      case 0x65: // e
        this.flushOther();
        this.identStart = this.pos;
        this.identBuf.length = 0;
        this.state = State.MaybeE;
        break;
      default:
        if (isSpace(b)) {
          this.flushOther();
        } else if (isIdentStart(b)) {
          this.flushOther();
          this.identStart = this.pos;
          this.identBuf.length = 0;
          if (this.identBuf.length < MAX_IDENT_BUF) this.identBuf.push(b);
          this.state = State.Ident;
        } else {
          this.startOther(this.pos);
        }
        break;
    }
  }
}

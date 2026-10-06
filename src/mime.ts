import { parseHeaders, parseContentType } from "./headers";
import { ByteDecoder, CharDecoder, createTransferDecoder, createCharsetDecoder } from "./decode";

export interface MimeEvents {
  onLeafStart(): void;
  onLeafText(text: string): void;
  onLeafEnd(): void;
}

const MAX_DEPTH = 8;
const MAX_HEADER_BYTES = 8192;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const DASH = 0x2d;

type Mode = "headers" | "lines" | "done";

interface BoundaryMatch {
  depth: number;
  closing: boolean;
}

function isPadding(byte: number): boolean {
  return byte === SPACE || byte === TAB;
}

function allPadding(bytes: number[], from: number): boolean {
  for (let i = from; i < bytes.length; i++) {
    if (!isPadding(bytes[i]!)) {
      return false;
    }
  }
  return true;
}

function startsWithAt(bytes: number[], from: number, prefix: Uint8Array): boolean {
  if (bytes.length - from < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[from + i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

export class MimeParser {
  private events: MimeEvents;
  private mode: Mode = "headers";
  private stack: Uint8Array[] = [];
  private headerBuf: number[] = [];
  private atLineStart = false;
  private pending: number[] = [];
  private pendingCR = false;
  private heldCR = false;
  private heldCrlf = false;
  private sinkLeaf = false;
  private transferDecoder: ByteDecoder | null = null;
  private charsetDecoder: CharDecoder | null = null;
  private bodyBatch: number[] = [];

  constructor(events: MimeEvents) {
    this.events = events;
  }

  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.feedByte(byte);
    }
    this.flushBodyBatch();
  }

  finish(): void {
    if (this.mode === "headers") {
      this.endHeaders();
    }
    if (this.mode === "lines") {
      if (this.atLineStart) {
        this.resolveLineAtEof();
      } else if (this.heldCR) {
        this.emitToBody([CR]);
        this.heldCR = false;
      }
      this.endLeafIfNeeded();
    }
    if (this.stack.length > 0) {
      throw new Error("unclosed multipart: missing closing boundary");
    }
  }

  private feedByte(byte: number): void {
    switch (this.mode) {
      case "headers":
        this.feedHeaderByte(byte);
        return;
      case "lines":
        this.feedLineByte(byte);
        return;
      case "done":
        return;
    }
  }

  private feedHeaderByte(byte: number): void {
    this.headerBuf.push(byte);
    const len = this.headerBuf.length;
    if (len > MAX_HEADER_BYTES + 4) {
      throw new Error("part headers exceed 8 KiB limit");
    }
    const emptyHeaders = len === 2 && this.headerBuf[0] === CR && this.headerBuf[1] === LF;
    const terminated =
      len >= 4 &&
      this.headerBuf[len - 4] === CR &&
      this.headerBuf[len - 3] === LF &&
      this.headerBuf[len - 2] === CR &&
      this.headerBuf[len - 1] === LF;
    if (emptyHeaders) {
      this.headerBuf = [];
      this.endHeaders();
    } else if (terminated) {
      this.headerBuf = this.headerBuf.slice(0, len - 4);
      this.endHeaders();
    }
  }

  private endHeaders(): void {
    let raw = "";
    for (const byte of this.headerBuf) {
      raw += String.fromCharCode(byte);
    }
    this.headerBuf = [];
    const headers = parseHeaders(raw);
    const contentTypeValue = headers.get("content-type");
    const contentType = contentTypeValue !== undefined
      ? parseContentType(contentTypeValue)
      : { mediaType: "text/plain", params: new Map<string, string>() };

    if (contentType.mediaType.startsWith("multipart/")) {
      const boundary = contentType.params.get("boundary");
      if (boundary === undefined || boundary.length === 0) {
        throw new Error("multipart content type missing boundary");
      }
      if (boundary.length > 70) {
        throw new Error("multipart boundary exceeds 70 characters");
      }
      const delimiter: number[] = [DASH, DASH];
      for (const ch of boundary) {
        const code = ch.charCodeAt(0);
        if (code > 0x7f) {
          throw new Error("multipart boundary must be ASCII");
        }
        delimiter.push(code);
      }
      if (this.stack.length >= MAX_DEPTH) {
        throw new Error("multipart nesting exceeds 8 levels");
      }
      this.stack.push(Uint8Array.from(delimiter));
      this.sinkLeaf = false;
      this.enterLinesMode();
      return;
    }

    if (contentType.mediaType === "text/plain") {
      const charset = contentType.params.get("charset") ?? "us-ascii";
      const encoding = headers.get("content-transfer-encoding") ?? "7bit";
      this.transferDecoder = createTransferDecoder(encoding);
      this.charsetDecoder = createCharsetDecoder(charset);
      this.sinkLeaf = true;
      this.events.onLeafStart();
    } else {
      this.sinkLeaf = false;
    }
    this.enterLinesMode();
  }

  private enterLinesMode(): void {
    this.mode = "lines";
    this.atLineStart = true;
    this.pending = [];
    this.pendingCR = false;
    this.heldCR = false;
    this.heldCrlf = false;
  }

  private feedLineByte(byte: number): void {
    if (this.atLineStart) {
      this.feedDecidingByte(byte);
      return;
    }
    if (this.heldCR) {
      this.heldCR = false;
      if (byte === LF) {
        this.atLineStart = true;
        this.heldCrlf = true;
        this.pending = [];
        this.pendingCR = false;
        return;
      }
      this.emitToBody([CR]);
    }
    if (byte === CR) {
      this.heldCR = true;
      return;
    }
    this.emitToBody([byte]);
  }

  private feedDecidingByte(byte: number): void {
    if (this.pendingCR) {
      if (byte === LF) {
        this.pendingCR = false;
        this.resolveLine();
        return;
      }
      this.pending.push(CR);
      this.pendingCR = false;
    }
    if (byte === CR) {
      this.pendingCR = true;
      return;
    }
    this.pending.push(byte);
    if (!this.isConsistent()) {
      this.flushPendingAsBody();
    }
  }

  private isConsistent(): boolean {
    for (const delimiter of this.stack) {
      if (this.consistentWith(delimiter)) {
        return true;
      }
    }
    return false;
  }

  private consistentWith(delimiter: Uint8Array): boolean {
    const p = this.pending;
    let i = 0;
    while (i < p.length && i < delimiter.length && p[i] === delimiter[i]) {
      i++;
    }
    if (i < p.length && i < delimiter.length) {
      return false;
    }
    if (p.length <= delimiter.length) {
      return true;
    }
    const rest = p.slice(delimiter.length);
    if (rest[0] === DASH) {
      if (rest.length === 1) {
        return true;
      }
      if (rest[1] !== DASH) {
        return false;
      }
      return allPadding(rest, 2);
    }
    return allPadding(rest, 0);
  }

  private matchDelimiter(delimiter: Uint8Array): "open" | "close" | null {
    const p = this.pending;
    if (p.length < delimiter.length) {
      return null;
    }
    if (!startsWithAt(p, 0, delimiter)) {
      return null;
    }
    const rest = p.slice(delimiter.length);
    if (allPadding(rest, 0)) {
      return "open";
    }
    if (rest.length >= 2 && rest[0] === DASH && rest[1] === DASH && allPadding(rest, 2)) {
      return "close";
    }
    return null;
  }

  private resolveLine(): void {
    const match = this.classify();
    if (match === null) {
      this.flushPendingAsBody();
      return;
    }
    this.pending = [];
    this.heldCrlf = false;
    this.handleDelimiter(match);
  }

  private resolveLineAtEof(): void {
    if (this.pendingCR) {
      this.pendingCR = false;
      this.resolveLine();
      return;
    }
    const match = this.classify();
    if (match !== null) {
      this.pending = [];
      this.heldCrlf = false;
      this.handleDelimiter(match);
      return;
    }
    this.flushPendingAsBody();
  }

  private classify(): BoundaryMatch | null {
    for (let depth = this.stack.length - 1; depth >= 0; depth--) {
      const kind = this.matchDelimiter(this.stack[depth]!);
      if (kind !== null) {
        return { depth, closing: kind === "close" };
      }
    }
    return null;
  }

  private flushPendingAsBody(): void {
    const bytes = this.heldCrlf ? [CR, LF, ...this.pending] : [...this.pending];
    this.pending = [];
    this.heldCrlf = false;
    this.atLineStart = false;
    this.emitToBody(bytes);
  }

  private handleDelimiter(match: BoundaryMatch): void {
    if (match.depth !== this.stack.length - 1) {
      throw new Error("unclosed multipart: inner boundary never closed");
    }
    this.endLeafIfNeeded();
    if (match.closing) {
      this.stack.pop();
      if (this.stack.length === 0) {
        this.mode = "done";
        this.sinkLeaf = false;
        return;
      }
      this.sinkLeaf = false;
      this.enterLinesMode();
      return;
    }
    this.mode = "headers";
    this.headerBuf = [];
    this.sinkLeaf = false;
  }

  private endLeafIfNeeded(): void {
    if (!this.sinkLeaf) {
      return;
    }
    this.flushBodyBatch();
    const tailBytes = this.transferDecoder!.finish();
    let text = "";
    if (tailBytes.length > 0) {
      text += this.charsetDecoder!.write(tailBytes);
    }
    text += this.charsetDecoder!.finish();
    if (text.length > 0) {
      this.events.onLeafText(text);
    }
    this.events.onLeafEnd();
    this.sinkLeaf = false;
    this.transferDecoder = null;
    this.charsetDecoder = null;
  }

  private emitToBody(bytes: number[]): void {
    if (!this.sinkLeaf || bytes.length === 0) {
      return;
    }
    for (const byte of bytes) {
      this.bodyBatch.push(byte);
    }
    if (this.bodyBatch.length >= 8192) {
      this.flushBodyBatch();
    }
  }

  private flushBodyBatch(): void {
    if (!this.sinkLeaf || this.bodyBatch.length === 0) {
      this.bodyBatch = [];
      return;
    }
    const decoded = this.transferDecoder!.write(Uint8Array.from(this.bodyBatch));
    this.bodyBatch = [];
    if (decoded.length === 0) {
      return;
    }
    const text = this.charsetDecoder!.write(decoded);
    if (text.length > 0) {
      this.events.onLeafText(text);
    }
  }
}

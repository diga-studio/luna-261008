"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MimeParser = void 0;
const headers_1 = require("./headers");
const decode_1 = require("./decode");
const MAX_DEPTH = 8;
const MAX_HEADER_BYTES = 8192;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const DASH = 0x2d;
function isPadding(byte) {
    return byte === SPACE || byte === TAB;
}
function allPadding(bytes, from) {
    for (let i = from; i < bytes.length; i++) {
        if (!isPadding(bytes[i])) {
            return false;
        }
    }
    return true;
}
function startsWithAt(bytes, from, prefix) {
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
class MimeParser {
    events;
    mode = "headers";
    stack = [];
    headerBuf = [];
    atLineStart = false;
    pending = [];
    pendingCR = false;
    heldCR = false;
    heldCrlf = false;
    sinkLeaf = false;
    transferDecoder = null;
    charsetDecoder = null;
    bodyBatch = [];
    constructor(events) {
        this.events = events;
    }
    write(bytes) {
        for (const byte of bytes) {
            this.feedByte(byte);
        }
        this.flushBodyBatch();
    }
    finish() {
        if (this.mode === "headers") {
            this.endHeaders();
        }
        if (this.mode === "lines") {
            if (this.atLineStart) {
                this.resolveLineAtEof();
            }
            else if (this.heldCR) {
                this.emitToBody([CR]);
                this.heldCR = false;
            }
            this.endLeafIfNeeded();
        }
        if (this.stack.length > 0) {
            throw new Error("unclosed multipart: missing closing boundary");
        }
    }
    feedByte(byte) {
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
    feedHeaderByte(byte) {
        this.headerBuf.push(byte);
        const len = this.headerBuf.length;
        if (len > MAX_HEADER_BYTES + 4) {
            throw new Error("part headers exceed 8 KiB limit");
        }
        const emptyHeaders = len === 2 && this.headerBuf[0] === CR && this.headerBuf[1] === LF;
        const terminated = len >= 4 &&
            this.headerBuf[len - 4] === CR &&
            this.headerBuf[len - 3] === LF &&
            this.headerBuf[len - 2] === CR &&
            this.headerBuf[len - 1] === LF;
        if (emptyHeaders) {
            this.headerBuf = [];
            this.endHeaders();
        }
        else if (terminated) {
            this.headerBuf = this.headerBuf.slice(0, len - 4);
            this.endHeaders();
        }
    }
    endHeaders() {
        let raw = "";
        for (const byte of this.headerBuf) {
            raw += String.fromCharCode(byte);
        }
        this.headerBuf = [];
        const headers = (0, headers_1.parseHeaders)(raw);
        const contentTypeValue = headers.get("content-type");
        const contentType = contentTypeValue !== undefined
            ? (0, headers_1.parseContentType)(contentTypeValue)
            : { mediaType: "text/plain", params: new Map() };
        if (contentType.mediaType.startsWith("multipart/")) {
            const boundary = contentType.params.get("boundary");
            if (boundary === undefined || boundary.length === 0) {
                throw new Error("multipart content type missing boundary");
            }
            if (boundary.length > 70) {
                throw new Error("multipart boundary exceeds 70 characters");
            }
            const delimiter = [DASH, DASH];
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
            this.transferDecoder = (0, decode_1.createTransferDecoder)(encoding);
            this.charsetDecoder = (0, decode_1.createCharsetDecoder)(charset);
            this.sinkLeaf = true;
            this.events.onLeafStart();
        }
        else {
            this.sinkLeaf = false;
        }
        this.enterLinesMode();
    }
    enterLinesMode() {
        this.mode = "lines";
        this.atLineStart = true;
        this.pending = [];
        this.pendingCR = false;
        this.heldCR = false;
        this.heldCrlf = false;
    }
    feedLineByte(byte) {
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
    feedDecidingByte(byte) {
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
    isConsistent() {
        for (const delimiter of this.stack) {
            if (this.consistentWith(delimiter)) {
                return true;
            }
        }
        return false;
    }
    consistentWith(delimiter) {
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
    matchDelimiter(delimiter) {
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
    resolveLine() {
        const match = this.classify();
        if (match === null) {
            this.flushPendingAsBody();
            return;
        }
        this.pending = [];
        this.heldCrlf = false;
        this.handleDelimiter(match);
    }
    resolveLineAtEof() {
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
    classify() {
        for (let depth = this.stack.length - 1; depth >= 0; depth--) {
            const kind = this.matchDelimiter(this.stack[depth]);
            if (kind !== null) {
                return { depth, closing: kind === "close" };
            }
        }
        return null;
    }
    flushPendingAsBody() {
        const bytes = this.heldCrlf ? [CR, LF, ...this.pending] : [...this.pending];
        this.pending = [];
        this.heldCrlf = false;
        this.atLineStart = false;
        this.emitToBody(bytes);
    }
    handleDelimiter(match) {
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
    endLeafIfNeeded() {
        if (!this.sinkLeaf) {
            return;
        }
        this.flushBodyBatch();
        const tailBytes = this.transferDecoder.finish();
        let text = "";
        if (tailBytes.length > 0) {
            text += this.charsetDecoder.write(tailBytes);
        }
        text += this.charsetDecoder.finish();
        if (text.length > 0) {
            this.events.onLeafText(text);
        }
        this.events.onLeafEnd();
        this.sinkLeaf = false;
        this.transferDecoder = null;
        this.charsetDecoder = null;
    }
    emitToBody(bytes) {
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
    flushBodyBatch() {
        if (!this.sinkLeaf || this.bodyBatch.length === 0) {
            this.bodyBatch = [];
            return;
        }
        const decoded = this.transferDecoder.write(Uint8Array.from(this.bodyBatch));
        this.bodyBatch = [];
        if (decoded.length === 0) {
            return;
        }
        const text = this.charsetDecoder.write(decoded);
        if (text.length > 0) {
            this.events.onLeafText(text);
        }
    }
}
exports.MimeParser = MimeParser;

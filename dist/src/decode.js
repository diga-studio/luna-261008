"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCharsetDecoder = exports.createTransferDecoder = void 0;
class PassThroughDecoder {
    write(bytes) {
        return bytes;
    }
    finish() {
        return new Uint8Array(0);
    }
}
const B64_VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
    B64_VALUES[65 + i] = i;
    B64_VALUES[97 + i] = 26 + i;
}
for (let i = 0; i < 10; i++) {
    B64_VALUES[48 + i] = 52 + i;
}
B64_VALUES[43] = 62;
B64_VALUES[47] = 63;
class Base64Decoder {
    pending = [];
    terminated = false;
    write(bytes) {
        const out = [];
        for (const byte of bytes) {
            if (this.terminated) {
                continue;
            }
            if (byte === 0x3d) {
                this.terminated = true;
                this.flushFinal(out);
                continue;
            }
            if (byte === 0x0d || byte === 0x0a || byte === 0x20 || byte === 0x09) {
                continue;
            }
            const value = byte < 128 ? B64_VALUES[byte] : -1;
            if (value < 0) {
                continue;
            }
            this.pending.push(value);
            if (this.pending.length === 4) {
                this.emitGroup(out, 4);
            }
        }
        return Uint8Array.from(out);
    }
    emitGroup(out, count) {
        const p = this.pending;
        out.push((p[0] << 2) | (p[1] >> 4));
        if (count >= 3) {
            out.push(((p[1] & 0x0f) << 4) | (p[2] >> 2));
        }
        if (count >= 4) {
            out.push(((p[2] & 0x03) << 6) | p[3]);
        }
        this.pending = [];
    }
    flushFinal(out) {
        const count = this.pending.length;
        if (count >= 2) {
            this.emitGroup(out, count);
        }
        else {
            this.pending = [];
        }
    }
    finish() {
        const out = [];
        if (!this.terminated) {
            this.flushFinal(out);
        }
        this.pending = [];
        return Uint8Array.from(out);
    }
}
function hexValue(byte) {
    if (byte >= 0x30 && byte <= 0x39)
        return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46)
        return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66)
        return byte - 0x61 + 10;
    return -1;
}
class QuotedPrintableDecoder {
    pending = [];
    write(bytes) {
        const out = [];
        let index = 0;
        while (index < bytes.length) {
            if (this.pending.length === 0) {
                const byte = bytes[index];
                if (byte === 0x3d) {
                    this.pending.push(byte);
                    index++;
                }
                else {
                    out.push(byte);
                    index++;
                }
                continue;
            }
            while (this.pending.length < this.pendingNeeded() && index < bytes.length) {
                this.pending.push(bytes[index]);
                index++;
            }
            if (this.pending.length < this.pendingNeeded()) {
                break;
            }
            this.resolvePending(out);
        }
        return Uint8Array.from(out);
    }
    pendingNeeded() {
        if (this.pending.length === 1) {
            return 2;
        }
        const second = this.pending[1];
        if (second === 0x0d) {
            return 3;
        }
        if (second === 0x0a) {
            return 2;
        }
        return 3;
    }
    resolvePending(out) {
        const second = this.pending[1];
        if (second === 0x0d && this.pending[2] === 0x0a) {
            this.pending = [];
            return;
        }
        if (second === 0x0a) {
            this.pending = [];
            return;
        }
        const hi = hexValue(second);
        const lo = this.pending.length > 2 ? hexValue(this.pending[2]) : -1;
        if (hi >= 0 && lo >= 0) {
            out.push((hi << 4) | lo);
            this.pending = [];
            return;
        }
        out.push(0x3d);
        this.pending = this.pending.slice(1);
    }
    finish() {
        const out = [];
        while (this.pending.length > 0) {
            if (this.pending.length >= this.pendingNeeded()) {
                this.resolvePending(out);
            }
            else {
                out.push(this.pending[0]);
                this.pending = this.pending.slice(1);
            }
        }
        return Uint8Array.from(out);
    }
}
function createTransferDecoder(encoding) {
    switch (encoding.trim().toLowerCase()) {
        case "7bit":
        case "8bit":
        case "binary":
            return new PassThroughDecoder();
        case "base64":
            return new Base64Decoder();
        case "quoted-printable":
            return new QuotedPrintableDecoder();
        default:
            throw new Error(`unsupported content-transfer-encoding: ${encoding}`);
    }
}
exports.createTransferDecoder = createTransferDecoder;
class AsciiCharDecoder {
    write(bytes) {
        let text = "";
        for (const byte of bytes) {
            text += String.fromCharCode(byte);
        }
        return text;
    }
    finish() {
        return "";
    }
}
class Utf8CharDecoder {
    pending = [];
    write(bytes) {
        let text = "";
        for (const byte of bytes) {
            this.pending.push(byte);
            const decoded = this.tryDecode();
            if (decoded !== null) {
                text += decoded;
            }
        }
        return text;
    }
    tryDecode() {
        const first = this.pending[0];
        let length;
        if (first < 0x80) {
            length = 1;
        }
        else if (first >= 0xc2 && first <= 0xdf) {
            length = 2;
        }
        else if (first >= 0xe0 && first <= 0xef) {
            length = 3;
        }
        else if (first >= 0xf0 && first <= 0xf4) {
            length = 4;
        }
        else {
            this.pending.shift();
            return "�";
        }
        if (this.pending.length < length) {
            return null;
        }
        const seq = this.pending.slice(0, length);
        for (let i = 1; i < length; i++) {
            if ((seq[i] & 0xc0) !== 0x80) {
                this.pending.shift();
                return "�";
            }
        }
        this.pending.splice(0, length);
        let codePoint;
        if (length === 1) {
            codePoint = seq[0];
        }
        else if (length === 2) {
            codePoint = ((seq[0] & 0x1f) << 6) | (seq[1] & 0x3f);
        }
        else if (length === 3) {
            codePoint = ((seq[0] & 0x0f) << 12) | ((seq[1] & 0x3f) << 6) | (seq[2] & 0x3f);
        }
        else {
            codePoint =
                ((seq[0] & 0x07) << 18) |
                    ((seq[1] & 0x3f) << 12) |
                    ((seq[2] & 0x3f) << 6) |
                    (seq[3] & 0x3f);
        }
        return String.fromCodePoint(codePoint);
    }
    finish() {
        let text = "";
        while (this.pending.length > 0) {
            this.pending.shift();
            text += "�";
        }
        return text;
    }
}
function createCharsetDecoder(charset) {
    switch (charset.trim().toLowerCase()) {
        case "us-ascii":
        case "ascii":
            return new AsciiCharDecoder();
        case "utf-8":
        case "utf8":
            return new Utf8CharDecoder();
        default:
            throw new Error(`unsupported charset: ${charset}`);
    }
}
exports.createCharsetDecoder = createCharsetDecoder;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertThrows = exports.assertSetEqual = exports.assertEqual = exports.assertTrue = exports.quotedPrintableEncode = exports.base64Encode = exports.concat = exports.mail = exports.ascii = exports.utf8 = void 0;
const encoder = new TextEncoder();
function utf8(text) {
    return encoder.encode(text);
}
exports.utf8 = utf8;
function ascii(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        out[i] = text.charCodeAt(i);
    }
    return out;
}
exports.ascii = ascii;
function mail(lines) {
    return utf8(lines.join("\r\n"));
}
exports.mail = mail;
function concat(...parts) {
    let total = 0;
    for (const part of parts) {
        total += part.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
exports.concat = concat;
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64_ALPHABET[a >> 2];
        out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
        out += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : "=";
    }
    return out;
}
exports.base64Encode = base64Encode;
function quotedPrintableEncode(bytes) {
    let out = "";
    for (const byte of bytes) {
        if (byte >= 33 && byte <= 126 && byte !== 61) {
            out += String.fromCharCode(byte);
        }
        else {
            out += "=" + byte.toString(16).toUpperCase().padStart(2, "0");
        }
    }
    return out;
}
exports.quotedPrintableEncode = quotedPrintableEncode;
function assertTrue(condition, message) {
    if (!condition) {
        throw new Error(`assertion failed: ${message}`);
    }
}
exports.assertTrue = assertTrue;
function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`assertion failed: ${message}\n  expected: ${expected}\n  actual:   ${actual}`);
    }
}
exports.assertEqual = assertEqual;
function assertSetEqual(actual, expected, message) {
    const a = [...actual].sort();
    const e = [...expected].sort();
    assertTrue(a.length === e.length && a.every((value, index) => value === e[index]), `${message}\n  expected set: ${JSON.stringify(e)}\n  actual set:   ${JSON.stringify(a)}`);
}
exports.assertSetEqual = assertSetEqual;
function assertThrows(fn, message) {
    try {
        fn();
    }
    catch {
        return;
    }
    throw new Error(`assertion failed: expected throw — ${message}`);
}
exports.assertThrows = assertThrows;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseContentType = exports.parseHeaders = void 0;
function parseHeaders(raw) {
    const values = new Map();
    const lines = raw.split("\r\n");
    let currentName = null;
    let currentValue = "";
    const commit = () => {
        if (currentName !== null && !values.has(currentName)) {
            values.set(currentName, currentValue.trim());
        }
    };
    for (const line of lines) {
        if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
            if (currentName !== null) {
                currentValue += " " + line.trim();
            }
            continue;
        }
        commit();
        const colon = line.indexOf(":");
        if (colon <= 0) {
            currentName = null;
            currentValue = "";
            continue;
        }
        currentName = line.slice(0, colon).trim().toLowerCase();
        currentValue = line.slice(colon + 1);
    }
    commit();
    return {
        get(name) {
            return values.get(name.toLowerCase());
        },
    };
}
exports.parseHeaders = parseHeaders;
function splitParams(value) {
    const parts = [];
    let current = "";
    let inQuotes = false;
    let escaped = false;
    for (const ch of value) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (inQuotes && ch === "\\") {
            current += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
            continue;
        }
        if (ch === ";" && !inQuotes) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
        let result = "";
        let escaped = false;
        for (const ch of trimmed.slice(1, -1)) {
            if (escaped) {
                result += ch;
                escaped = false;
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else {
                result += ch;
            }
        }
        return result;
    }
    return trimmed;
}
function parseContentType(value) {
    const parts = splitParams(value);
    const mediaType = (parts[0] ?? "").trim().toLowerCase();
    const params = new Map();
    for (const part of parts.slice(1)) {
        const eq = part.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const name = part.slice(0, eq).trim().toLowerCase();
        const paramValue = unquote(part.slice(eq + 1));
        if (name.length > 0 && !params.has(name)) {
            params.set(name, paramValue);
        }
    }
    return { mediaType, params };
}
exports.parseContentType = parseContentType;

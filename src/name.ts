import { DnsName, ZoneParseError } from './types';

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function foldByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function checkName(labels: DnsName, line?: number): DnsName {
  let total = 1; // root label
  for (const label of labels) {
    if (label.length === 0) throw new ZoneParseError('empty label in name', line);
    if (label.length > 63) {
      throw new ZoneParseError(`label exceeds 63 bytes (${label.length})`, line);
    }
    total += 1 + label.length;
  }
  if (total > 255) {
    throw new ZoneParseError(`name exceeds 255 wire bytes (${total})`, line);
  }
  return labels;
}

/**
 * Parse a presentation-format name (raw token text, escapes intact) into an
 * absolute DnsName. `@` alone denotes the origin; a trailing unescaped dot
 * marks an absolute name; anything else is relative to the origin.
 */
export function parseName(raw: string, origin: DnsName, line?: number): DnsName {
  if (raw.length === 0) throw new ZoneParseError('empty name', line);
  if (raw === '@') return origin.slice();
  if (raw === '.') return [];

  const labels: Uint8Array[] = [];
  let current: number[] = [];
  let absolute = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === undefined) {
        throw new ZoneParseError('trailing backslash in name', line);
      }
      if (isDigit(next)) {
        const digits = raw.substr(i + 1, 3);
        if (digits.length !== 3 || !/^[0-9]{3}$/.test(digits)) {
          throw new ZoneParseError(`bad numeric escape \\${digits}`, line);
        }
        const value = parseInt(digits, 10);
        if (value > 255) {
          throw new ZoneParseError(`escape \\${digits} exceeds 255`, line);
        }
        current.push(value);
        i += 4;
      } else {
        current.push(next.charCodeAt(0));
        i += 2;
      }
    } else if (c === '.') {
      if (current.length === 0) {
        throw new ZoneParseError('empty label in name', line);
      }
      labels.push(Uint8Array.from(current));
      current = [];
      if (i === raw.length - 1) absolute = true;
      i += 1;
    } else {
      current.push(c.charCodeAt(0));
      i += 1;
    }
  }
  if (!absolute) {
    if (current.length === 0) {
      // raw ended with an escape or char handled above; cannot be empty here
      throw new ZoneParseError('malformed name', line);
    }
    labels.push(Uint8Array.from(current));
    return checkName(labels.concat(origin.slice()), line);
  }
  if (current.length !== 0) {
    throw new ZoneParseError('malformed name', line);
  }
  return checkName(labels, line);
}

const ESCAPE_CHARS = new Set(['.', '\\', '"', '(', ')', ';', ' ', '@', '$']);

function labelToString(label: Uint8Array): string {
  let out = '';
  for (const b of label) {
    const ch = String.fromCharCode(b);
    if (b >= 0x21 && b <= 0x7e && !ESCAPE_CHARS.has(ch)) {
      out += ch;
    } else if (ESCAPE_CHARS.has(ch)) {
      out += '\\' + ch;
    } else {
      out += '\\' + b.toString().padStart(3, '0');
    }
  }
  return out;
}

/** Canonical presentation format: escaped labels joined by dots, trailing dot. */
export function nameToString(name: DnsName): string {
  if (name.length === 0) return '.';
  return name.map(labelToString).join('.') + '.';
}

/** RFC 4034 canonical order: compare from the root label outward. */
export function compareNames(a: DnsName, b: DnsName): number {
  let ia = a.length - 1;
  let ib = b.length - 1;
  while (ia >= 0 && ib >= 0) {
    const la = a[ia]!;
    const lb = b[ib]!;
    const n = Math.min(la.length, lb.length);
    for (let k = 0; k < n; k++) {
      const d = foldByte(la[k]!) - foldByte(lb[k]!);
      if (d !== 0) return d;
    }
    if (la.length !== lb.length) return la.length - lb.length;
    ia--;
    ib--;
  }
  return a.length - b.length;
}

export function namesEqual(a: DnsName, b: DnsName): boolean {
  return compareNames(a, b) === 0;
}

/** True if `name` equals or is a descendant of `suffix`. */
export function nameInZone(name: DnsName, suffix: DnsName): boolean {
  if (name.length < suffix.length) return false;
  const offset = name.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    const la = name[offset + i]!;
    const lb = suffix[i]!;
    if (la.length !== lb.length) return false;
    for (let k = 0; k < la.length; k++) {
      if (foldByte(la[k]!) !== foldByte(lb[k]!)) return false;
    }
  }
  return true;
}

/** Canonical byte key for map lookups. */
export function nameKey(name: DnsName): string {
  return name
    .map((l) => Array.from(l, foldByte).join(','))
    .join('.');
}

import { ZoneError, ZoneName } from './types';

function lowerByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function validateName(labels: Uint8Array[], line?: number): ZoneName {
  let total = 1; // root label
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      throw new ZoneError('label length must be 1..63 bytes', line);
    }
    total += label.length + 1;
  }
  if (total > 255) {
    throw new ZoneError('full name exceeds 255 bytes', line);
  }
  return { labels };
}

/**
 * Split token bytes into labels on unescaped dots. Returns the labels plus
 * whether the name ended with an unescaped trailing dot (absolute).
 */
function splitLabels(bytes: Uint8Array, escaped: Uint8Array): { labels: Uint8Array[]; absolute: boolean } {
  const labels: Uint8Array[] = [];
  let current: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x2e && escaped[i] === 0) {
      labels.push(Uint8Array.from(current));
      current = [];
    } else {
      current.push(bytes[i]!);
    }
  }
  labels.push(Uint8Array.from(current));
  let absolute = false;
  if (labels.length > 1 && labels[labels.length - 1]!.length === 0) {
    labels.pop();
    absolute = true;
  }
  if (absolute && labels.length === 1 && labels[0]!.length === 0) {
    // The root name spelled as ".".
    labels.pop();
  }
  return { labels, absolute };
}

/**
 * Resolve a name token against the current origin. An unescaped `@` alone
 * means the origin; an unescaped trailing dot marks an absolute name;
 * anything else is relative to the origin.
 */
export function resolveName(
  bytes: Uint8Array,
  escaped: Uint8Array,
  origin: ZoneName,
  line?: number,
): ZoneName {
  if (bytes.length === 1 && bytes[0] === 0x40 && escaped[0] === 0) {
    return origin;
  }
  const { labels, absolute } = splitLabels(bytes, escaped);
  if (absolute) {
    return validateName(labels, line);
  }
  return validateName([...labels, ...origin.labels.map((l) => Uint8Array.from(l))], line);
}

/** Parse a textual absolute origin (e.g. "example.com.") into a ZoneName. */
export function parseAbsoluteName(text: string): ZoneName {
  const bytes: number[] = [];
  const escaped: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch.charCodeAt(0) > 0x7f) {
      throw new ZoneError('non-ASCII character in origin');
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        throw new ZoneError('trailing backslash in origin');
      }
      if (next >= '0' && next <= '9') {
        const digits = text.slice(i + 1, i + 4);
        if (!/^[0-9]{3}$/.test(digits)) {
          throw new ZoneError('escape with digit must have exactly three decimal digits');
        }
        const value = Number(digits);
        if (value > 255) {
          throw new ZoneError(`decimal escape \\${digits} exceeds 255`);
        }
        bytes.push(value);
        escaped.push(1);
        i += 3;
      } else {
        bytes.push(next.charCodeAt(0));
        escaped.push(1);
        i += 1;
      }
    } else {
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        throw new ZoneError('whitespace in origin must be escaped');
      }
      bytes.push(ch.charCodeAt(0));
      escaped.push(0);
    }
  }
  const { labels, absolute } = splitLabels(Uint8Array.from(bytes), Uint8Array.from(escaped));
  if (!absolute) {
    throw new ZoneError(`origin "${text}" is not an absolute name`);
  }
  return validateName(labels);
}

/** Canonical lowercase-ASCII key for name equality. */
export function nameKey(name: ZoneName): string {
  return name.labels
    .map((label) => {
      let hex = '';
      for (const b of label) {
        hex += lowerByte(b).toString(16).padStart(2, '0');
      }
      return `${label.length}:${hex}`;
    })
    .join('/');
}

/** True when `name` equals `zone` or lies below it. */
export function inZone(name: ZoneName, zone: ZoneName): boolean {
  if (name.labels.length < zone.labels.length) {
    return false;
  }
  const offset = name.labels.length - zone.labels.length;
  for (let i = 0; i < zone.labels.length; i += 1) {
    const a = name.labels[offset + i]!;
    const b = zone.labels[i]!;
    if (a.length !== b.length) {
      return false;
    }
    for (let j = 0; j < a.length; j += 1) {
      if (lowerByte(a[j]!) !== lowerByte(b[j]!)) {
        return false;
      }
    }
  }
  return true;
}

function formatLabel(label: Uint8Array): string {
  let out = '';
  for (const b of label) {
    const ch = String.fromCharCode(lowerByte(b));
    if (b < 0x21 || b > 0x7e) {
      out += `\\${b.toString(10).padStart(3, '0')}`;
    } else if (ch === '.' || ch === '\\' || ch === '"' || ch === ';' || ch === '(' || ch === ')' || ch === '@') {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Render a name relative to `origin` when possible ("@", "www", "a.b"), else absolute with trailing dot. */
export function formatName(name: ZoneName, origin: ZoneName): string {
  if (name.labels.length === 0) {
    return '.';
  }
  if (inZone(name, origin)) {
    const relative = name.labels.slice(0, name.labels.length - origin.labels.length);
    if (relative.length === 0) {
      return '@';
    }
    return relative.map(formatLabel).join('.');
  }
  return `${name.labels.map(formatLabel).join('.')}.`;
}

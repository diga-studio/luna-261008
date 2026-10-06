export interface ParsedHeaders {
  get(name: string): string | undefined;
}

export interface ContentTypeInfo {
  mediaType: string;
  params: Map<string, string>;
}

export function parseHeaders(raw: string): ParsedHeaders {
  const values = new Map<string, string>();
  const lines = raw.split("\r\n");
  let currentName: string | null = null;
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
    get(name: string): string | undefined {
      return values.get(name.toLowerCase());
    },
  };
}

function splitParams(value: string): string[] {
  const parts: string[] = [];
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

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    let result = "";
    let escaped = false;
    for (const ch of trimmed.slice(1, -1)) {
      if (escaped) {
        result += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        result += ch;
      }
    }
    return result;
  }
  return trimmed;
}

export function parseContentType(value: string): ContentTypeInfo {
  const parts = splitParams(value);
  const mediaType = (parts[0] ?? "").trim().toLowerCase();
  const params = new Map<string, string>();
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

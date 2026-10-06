export type AddressFamily = 4 | 6;

export interface ParsedAddress {
  family: AddressFamily;
  value: bigint;
}

export interface CidrInterval {
  family: AddressFamily;
  lo: bigint;
  hi: bigint;
}

function parseIpv4Part(part: string): bigint {
  if (!/^\d{1,3}$/.test(part)) {
    throw new Error(`invalid IPv4 octet: ${part}`);
  }
  const n = Number(part);
  if (n > 255) {
    throw new Error(`invalid IPv4 octet: ${part}`);
  }
  return BigInt(n);
}

function parseIpv4(input: string): ParsedAddress {
  const parts = input.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${input}`);
  }
  let value = 0n;
  for (const part of parts) {
    value = (value << 8n) | parseIpv4Part(part);
  }
  return { family: 4, value };
}

function parseIpv6(input: string): ParsedAddress {
  let rest = input.toLowerCase();
  const tailGroups: string[] = [];
  if (rest.includes(".")) {
    const idx = rest.lastIndexOf(":");
    if (idx < 0) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    const v4 = rest.slice(idx + 1);
    rest = rest.slice(0, idx);
    const parts = v4.split(".");
    if (parts.length !== 4) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    const octets = parts.map((p) => Number(parseIpv4Part(p)));
    tailGroups.push(((octets[0]! << 8) | octets[1]!).toString(16));
    tailGroups.push(((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const dcIdx = rest.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dcIdx >= 0) {
    if (rest.indexOf("::", dcIdx + 2) >= 0) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    head = rest.slice(0, dcIdx).split(":").filter((s) => s.length > 0);
    tail = rest.slice(dcIdx + 2).split(":").filter((s) => s.length > 0);
  } else {
    head = rest.split(":").filter((s) => s.length > 0);
    tail = [];
  }
  tail.push(...tailGroups);
  const total = head.length + tail.length;
  if (total > 8 || (dcIdx < 0 && total !== 8)) {
    throw new Error(`invalid IPv6 address: ${input}`);
  }
  const zeros = 8 - total;
  const groups = [...head, ...Array<string>(zeros).fill("0"), ...tail];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      throw new Error(`invalid IPv6 group: ${g}`);
    }
    value = (value << 16n) | BigInt(`0x${g}`);
  }
  return { family: 6, value };
}

export function parseIp(_input: string): ParsedAddress {
  if (_input.includes(":")) {
    return parseIpv6(_input);
  }
  return parseIpv4(_input);
}

export function formatIp(family: AddressFamily, value: bigint): string {
  if (family === 4) {
    const parts: string[] = [];
    for (let i = 3; i >= 0; i--) {
      parts.push(((value >> BigInt(i * 8)) & 0xffn).toString(10));
    }
    return parts.join(".");
  }
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (curStart < 0) {
        curStart = i;
        curLen = 0;
      }
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen >= 2) {
    const left = hex.slice(0, bestStart).join(":");
    const right = hex.slice(bestStart + bestLen).join(":");
    return `${left}::${right}`;
  }
  return hex.join(":");
}

export function cidrToInterval(cidr: string): CidrInterval {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const { family, value } = parseIp(cidr.slice(0, slash));
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`invalid CIDR prefix: ${cidr}`);
  }
  const hostBits = BigInt(bits - prefix);
  const lo = hostBits === 0n ? value : (value >> hostBits) << hostBits;
  const hi = lo + (1n << hostBits) - 1n;
  return { family, lo, hi };
}

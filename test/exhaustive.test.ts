import { describe, expect, it } from 'vitest';
import { auditPolicy, evaluateConnection } from '../src/index.js';
import type { Connection, Rule } from '../src/index.js';
import { formatAddress, parseCidr, type AddressFamily } from '../src/ip.js';

/** 确定性伪随机数生成器（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Space {
  family: AddressFamily;
  srcCidr: string;
  dstCidr: string;
  ports: number[];
}

const V4_SPACE: Space = {
  family: 'ipv4',
  srcCidr: '10.9.0.0/30',
  dstCidr: '172.16.0.0/30',
  ports: [80, 81, 82, 83],
};

const V6_SPACE: Space = {
  family: 'ipv6',
  srcCidr: '2001:db8::/126',
  dstCidr: 'fd00::/126',
  ports: [0, 1, 2, 3],
};

function addresses(cidr: string): string[] {
  const range = parseCidr(cidr);
  const out: string[] = [];
  for (let v = range.start; v <= range.end; v++) {
    out.push(formatAddress(range.family, v));
  }
  return out;
}

function allConnections(space: Space): Connection[] {
  const srcs = addresses(space.srcCidr);
  const dsts = addresses(space.dstCidr);
  const out: Connection[] = [];
  for (const direction of ['inbound', 'outbound'] as const) {
    for (const src of srcs) {
      for (const dst of dsts) {
        for (const port of space.ports) {
          out.push({ direction, protocol: 'TCP', sourceAddress: src, destAddress: dst, destPort: port });
          out.push({ direction, protocol: 'UDP', sourceAddress: src, destAddress: dst, destPort: port });
        }
        out.push({ direction, protocol: 'ICMP', sourceAddress: src, destAddress: dst });
      }
    }
  }
  return out;
}

function randomRules(space: Space, seed: number, count: number): Rule[] {
  const rand = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const srcRange = parseCidr(space.srcCidr);
  const dstRange = parseCidr(space.dstCidr);
  const srcSize = Number(srcRange.end - srcRange.start + 1n);
  const dstSize = Number(dstRange.end - dstRange.start + 1n);
  const rules: Rule[] = [];
  for (let i = 0; i < count; i++) {
    const protocol = pick(['TCP', 'UDP', 'ICMP', 'ANY'] as const);
    const srcStart = srcRange.start + BigInt(Math.floor(rand() * srcSize));
    const srcEnd = srcStart + BigInt(Math.floor(rand() * Number(srcRange.end - srcStart + 1n)));
    const dstStart = dstRange.start + BigInt(Math.floor(rand() * dstSize));
    const dstEnd = dstStart + BigInt(Math.floor(rand() * Number(dstRange.end - dstStart + 1n)));
    const portLo = space.ports[0]!;
    const portHi = space.ports[space.ports.length - 1]!;
    const p1 = portLo + Math.floor(rand() * (portHi - portLo + 1));
    const p2 = p1 + Math.floor(rand() * (portHi - p1 + 1));
    rules.push({
      id: `r${i}`,
      // 故意制造大量同优先级，检验顺序语义。
      priority: 1 + Math.floor(rand() * 3),
      direction: pick(['inbound', 'outbound'] as const),
      protocol,
      sourceCidr: rangeToCidrs(srcRange.family, srcStart, srcEnd)[0]!,
      destCidr: rangeToCidrs(dstRange.family, dstStart, dstEnd)[0]!,
      action: pick(['allow', 'deny', 'log'] as const),
      ...(protocol === 'TCP' || protocol === 'UDP'
        ? { portRange: { start: p1, end: p2 } }
        : {}),
    });
  }
  return rules;
}

/** 把任意地址区间拆成 CIDR 列表（测试辅助，区间内取第一个 CIDR 会丢精度，故要求区间本身对齐）。 */
function rangeToCidrs(family: AddressFamily, start: bigint, end: bigint): string[] {
  const bits = family === 'ipv4' ? 32n : 128n;
  const cidrs: string[] = [];
  let cur = start;
  while (cur <= end) {
    let size = 0n;
    // 对齐：cur 末尾零的个数限制块大小。
    const tz = cur === 0n ? bits : BigInt(ctz(cur));
    while ((1n << size) <= end - cur + 1n && size < tz && size < bits) {
      size++;
    }
    while ((1n << size) > end - cur + 1n || size > tz) {
      size--;
    }
    cidrs.push(`${formatAddress(family, cur)}/${Number(bits - size)}`);
    cur += 1n << size;
  }
  return cidrs;
}

function ctz(v: bigint): number {
  let n = 0;
  while (((v >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}

function checkExhaustive(space: Space, seed: number): void {
  const rules = randomRules(space, seed, 12);
  const audits = auditPolicy(rules);
  const conns = allConnections(space);
  const firstHit = new Map<string, number>();
  for (const conn of conns) {
    const result = evaluateConnection(rules, conn);
    if (result.ruleId !== null) {
      firstHit.set(result.ruleId, (firstHit.get(result.ruleId) ?? 0) + 1);
    }
  }
  for (const audit of audits) {
    const hits = firstHit.get(audit.ruleId) ?? 0;
    if (audit.status === 'reachable') {
      expect(hits, `rule ${audit.ruleId} reported reachable but never first-hits`).toBeGreaterThan(0);
      // 见证必须真实首命中该规则。
      const witnessResult = evaluateConnection(rules, audit.witness!);
      expect(witnessResult.ruleId).toBe(audit.ruleId);
    } else {
      expect(hits, `rule ${audit.ruleId} reported shadowed but first-hits ${hits} connections`).toBe(0);
    }
  }
  // 可达规则集合与穷举首命中集合完全一致。
  const reachableIds = new Set(audits.filter((a) => a.status === 'reachable').map((a) => a.ruleId));
  expect(reachableIds).toEqual(new Set(firstHit.keys()));
}

describe('exhaustive consistency on small spaces', () => {
  it('IPv4 space: audit matches brute-force first-hit enumeration', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      checkExhaustive(V4_SPACE, seed);
    }
  });

  it('IPv6 space: audit matches brute-force first-hit enumeration', () => {
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      checkExhaustive(V6_SPACE, seed);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { formatAddress, parseAddress, parseCidr } from '../src/ip.js';

describe('parseAddress', () => {
  it('parses IPv4', () => {
    expect(parseAddress('10.1.2.3')).toEqual({ family: 'ipv4', value: 0x0a010203n });
    expect(parseAddress('0.0.0.0').value).toBe(0n);
    expect(parseAddress('255.255.255.255').value).toBe(0xffffffffn);
  });

  it('parses full and compressed IPv6', () => {
    expect(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001').value).toBe(
      (0x20010db8n << 96n) | 1n,
    );
    expect(parseAddress('2001:db8::1').value).toBe((0x20010db8n << 96n) | 1n);
    expect(parseAddress('::').value).toBe(0n);
    expect(parseAddress('::1').value).toBe(1n);
    expect(parseAddress('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff').value).toBe(
      (1n << 128n) - 1n,
    );
  });

  it('treats IPv4-mapped IPv6 as ipv6 family', () => {
    const parsed = parseAddress('::ffff:10.0.0.1');
    expect(parsed.family).toBe('ipv6');
    expect(parsed.value).toBe((0xffffn << 32n) | 0x0a000001n);
  });
});

describe('parseCidr', () => {
  it('computes IPv4 network range', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({
      family: 'ipv4',
      start: 0x0a000000n,
      end: 0x0affffffn,
    });
  });

  it('masks non-zero host bits down to the network prefix', () => {
    expect(parseCidr('10.1.2.3/8')).toEqual({
      family: 'ipv4',
      start: 0x0a000000n,
      end: 0x0affffffn,
    });
    expect(parseCidr('192.168.1.77/24').start).toBe(0xc0a80100n);
  });

  it('handles /0 and single-address ranges in both families', () => {
    expect(parseCidr('0.0.0.0/0')).toEqual({ family: 'ipv4', start: 0n, end: 0xffffffffn });
    expect(parseCidr('::/0')).toEqual({
      family: 'ipv6',
      start: 0n,
      end: (1n << 128n) - 1n,
    });
    expect(parseCidr('2001:db8::dead:beef/128')).toEqual({
      family: 'ipv6',
      start: (0x20010db8n << 96n) | 0xdeadbeefn,
      end: (0x20010db8n << 96n) | 0xdeadbeefn,
    });
  });
});

describe('formatAddress', () => {
  it('round-trips IPv4', () => {
    expect(formatAddress('ipv4', 0x0a010203n)).toBe('10.1.2.3');
    expect(formatAddress('ipv4', 0n)).toBe('0.0.0.0');
  });

  it('formats IPv6 with longest zero-run compression', () => {
    expect(formatAddress('ipv6', 0n)).toBe('::');
    expect(formatAddress('ipv6', 1n)).toBe('::1');
    expect(formatAddress('ipv6', (0x20010db8n << 96n) | 1n)).toBe('2001:db8::1');
    expect(formatAddress('ipv6', (1n << 128n) - 1n)).toBe(
      'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    );
    // 每段都非零时不压缩。
    expect(
      formatAddress('ipv6', 0x1234567890abcdef1234567890abcdefn),
    ).toBe('1234:5678:90ab:cdef:1234:5678:90ab:cdef');
  });

  it('round-trips through parseAddress', () => {
    const samples = ['10.0.0.1', '255.255.255.255', '::', '2001:db8::1', 'fe80::abcd'];
    for (const s of samples) {
      const { family, value } = parseAddress(s);
      expect(parseAddress(formatAddress(family, value)).value).toBe(value);
    }
  });
});

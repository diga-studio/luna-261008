import { describe, expect, it } from 'vitest';
import { evaluateConnection } from '../src/index.js';
import type { Connection, Rule } from '../src/index.js';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    priority: 100,
    direction: 'inbound',
    protocol: 'TCP',
    sourceCidr: '10.0.0.0/8',
    destCidr: '10.0.0.0/8',
    action: 'allow',
    portRange: { start: 80, end: 80 },
    ...partial,
  };
}

const tcpConn: Connection = {
  direction: 'inbound',
  protocol: 'TCP',
  sourceAddress: '10.1.1.1',
  destAddress: '10.2.2.2',
  destPort: 80,
};

describe('evaluateConnection', () => {
  it('returns the first matching rule and its action', () => {
    const rules = [rule({ id: 'a' }), rule({ id: 'b', priority: 200 })];
    expect(evaluateConnection(rules, tcpConn)).toEqual({ ruleId: 'a', action: 'allow' });
  });

  it('lower priority number wins regardless of input order', () => {
    const rules = [
      rule({ id: 'late', priority: 50 }),
      rule({ id: 'early', priority: 10, action: 'deny' }),
    ];
    expect(evaluateConnection(rules, tcpConn)).toEqual({ ruleId: 'early', action: 'deny' });
  });

  it('same priority falls back to input order', () => {
    const rules = [
      rule({ id: 'first', priority: 10 }),
      rule({ id: 'second', priority: 10, action: 'deny' }),
    ];
    expect(evaluateConnection(rules, tcpConn)).toEqual({ ruleId: 'first', action: 'allow' });
  });

  it('log action terminates the search', () => {
    const rules = [
      rule({ id: 'logger', action: 'log' }),
      rule({ id: 'backstop', priority: 200, action: 'allow' }),
    ];
    expect(evaluateConnection(rules, tcpConn)).toEqual({ ruleId: 'logger', action: 'log' });
  });

  it('default-denies when nothing matches', () => {
    const rules = [rule({ id: 'a', sourceCidr: '192.168.0.0/16' })];
    expect(evaluateConnection(rules, tcpConn)).toEqual({
      ruleId: null,
      action: 'default-deny',
    });
    expect(evaluateConnection([], tcpConn)).toEqual({ ruleId: null, action: 'default-deny' });
  });

  it('respects direction, port range and protocol', () => {
    const rules = [rule({ id: 'a', direction: 'outbound' })];
    expect(evaluateConnection(rules, tcpConn).ruleId).toBeNull();

    const portRules = [rule({ id: 'p', portRange: { start: 8000, end: 8080 } })];
    expect(evaluateConnection(portRules, tcpConn).ruleId).toBeNull();
    expect(
      evaluateConnection(portRules, { ...tcpConn, destPort: 8080 }).ruleId,
    ).toBe('p');

    const udpRules = [rule({ id: 'u', protocol: 'UDP', portRange: { start: 53, end: 53 } })];
    expect(evaluateConnection(udpRules, tcpConn).ruleId).toBeNull();
    expect(
      evaluateConnection(udpRules, {
        direction: 'inbound',
        protocol: 'UDP',
        sourceAddress: '10.1.1.1',
        destAddress: '10.2.2.2',
        destPort: 53,
      }).ruleId,
    ).toBe('u');
  });

  it('ANY matches TCP/UDP with any port and ICMP without port', () => {
    const rules = [rule({ id: 'any', protocol: 'ANY', portRange: undefined })];
    expect(evaluateConnection(rules, { ...tcpConn, destPort: 65000 }).ruleId).toBe('any');
    expect(
      evaluateConnection(rules, {
        direction: 'inbound',
        protocol: 'ICMP',
        sourceAddress: '10.1.1.1',
        destAddress: '10.2.2.2',
      }).ruleId,
    ).toBe('any');
  });

  it('ICMP rule does not match TCP/UDP connections', () => {
    const rules = [rule({ id: 'ping', protocol: 'ICMP', portRange: undefined })];
    expect(evaluateConnection(rules, tcpConn).ruleId).toBeNull();
    expect(
      evaluateConnection(rules, {
        direction: 'inbound',
        protocol: 'ICMP',
        sourceAddress: '10.1.1.1',
        destAddress: '10.2.2.2',
      }).ruleId,
    ).toBe('ping');
  });

  it('keeps IPv4 and IPv6 families disjoint, including IPv4-mapped IPv6', () => {
    const v4Rules = [rule({ id: 'v4' })];
    const v6Conn: Connection = {
      direction: 'inbound',
      protocol: 'TCP',
      sourceAddress: '::ffff:10.1.1.1',
      destAddress: '::ffff:10.2.2.2',
      destPort: 80,
    };
    // IPv4 映射 IPv6 地址属于 IPv6，不应命中 IPv4 规则。
    expect(evaluateConnection(v4Rules, v6Conn).ruleId).toBeNull();

    const v6Rules = [
      rule({
        id: 'v6',
        protocol: 'ANY',
        portRange: undefined,
        sourceCidr: '::/0',
        destCidr: '::/0',
      }),
    ];
    expect(evaluateConnection(v6Rules, v6Conn).ruleId).toBe('v6');
    expect(evaluateConnection(v6Rules, tcpConn).ruleId).toBeNull();
  });

  it('interprets non-zero host bits as the network prefix', () => {
    const rules = [rule({ id: 'net', sourceCidr: '10.9.9.9/8' })];
    expect(evaluateConnection(rules, tcpConn).ruleId).toBe('net');
  });

  it('rejects malformed connections and policies', () => {
    expect(() =>
      evaluateConnection([rule({ id: 'a' })], { ...tcpConn, destPort: undefined }),
    ).toThrow();
    expect(() =>
      evaluateConnection([rule({ id: 'a' })], {
        direction: 'inbound',
        protocol: 'ICMP',
        sourceAddress: '10.1.1.1',
        destAddress: '10.2.2.2',
        destPort: 8,
      }),
    ).toThrow();
    expect(() =>
      evaluateConnection([rule({ id: 'a' })], {
        ...tcpConn,
        destAddress: '2001:db8::1',
      }),
    ).toThrow();
    expect(() => evaluateConnection([rule({ id: 'a' }), rule({ id: 'a' })], tcpConn)).toThrow();
  });
});

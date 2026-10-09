import { describe, it, expect } from 'vitest';
import { rateLimitKey } from '../src/validate.js';

describe('rateLimitKey', () => {
  it('keeps an IPv4 address as-is', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses IPv6 addresses in one /64 to the same key', () => {
    const key = rateLimitKey('2001:db8:aa:bb::1');
    expect(key).toBe('2001:db8:aa:bb::/64');
    expect(rateLimitKey('2001:db8:aa:bb:dead:beef:1234:5678')).toBe(key);
    expect(rateLimitKey('2001:0DB8:00AA:00BB:ffff:ffff:ffff:ffff')).toBe(key);
  });

  it('keeps the neighbouring /64 distinct (boundary)', () => {
    expect(rateLimitKey('2001:db8:aa:bc::1')).not.toBe(rateLimitKey('2001:db8:aa:bb::1'));
    expect(rateLimitKey('2001:db8:aa:bb::')).toBe('2001:db8:aa:bb::/64');
  });

  it('expands :: anywhere in the address', () => {
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('[2001:db8::5]')).toBe('2001:db8:0:0::/64');
  });

  it('unwraps an IPv4-mapped IPv6 address to the IPv4 it carries', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('handles an embedded IPv4 tail that is not a mapped address', () => {
    expect(rateLimitKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it('returns anything unparseable unchanged', () => {
    expect(rateLimitKey('unknown')).toBe('unknown');
    expect(rateLimitKey('')).toBe('');
    expect(rateLimitKey('2001:db8:::1')).toBe('2001:db8:::1');
  });
});

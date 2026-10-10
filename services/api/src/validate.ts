import { isIPv4, isIPv6 } from 'node:net';
import type { RouteResult } from './router.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A 20-byte hex address, lowercased (the indexer stores addresses lowercase), or null. */
export function parseAddress(raw: string | undefined): string | null {
  if (raw === undefined || !ADDRESS_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/** `?limit=` as an integer in [1, max]; the default when absent; null when malformed. */
export function parseLimit(searchParams: URLSearchParams, fallback: number, max: number): number | null {
  const raw = searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

export function badRequest(error: string): RouteResult {
  return { code: 400, body: { error } };
}

/**
 * The key a per-client limit is counted against.
 *
 * IPv4 addresses are scarce, so one address is a fair stand-in for one client. IPv6 is not:
 * an ordinary home or VPS connection is handed a whole /64 (2^64 addresses) and can source
 * each request from a fresh one, so keying a limit on the full address is no limit at all.
 * Collapse IPv6 to its /64 network. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, how Node
 * reports IPv4 peers on a dual-stack socket) is the IPv4 address it carries. Anything that
 * is not a parseable IP is returned unchanged.
 */
export function rateLimitKey(ip: string): string {
  const raw = ip.trim();
  if (isIPv4(raw)) return raw;
  const hextets = parseIPv6(raw);
  if (!hextets) return raw;
  const isMappedV4 = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (isMappedV4) {
    return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join('.');
  }
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (zone index ignored), or null if not IPv6. */
function parseIPv6(raw: string): number[] | null {
  const ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!isIPv6(ip)) return null;
  // An embedded dotted IPv4 tail occupies the last two groups.
  let text = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => parseInt(h, 16));
}

import type { IncomingMessage } from 'node:http';
import { claimWbt } from '../faucet.js';
import type { RouteResult } from '../router.js';
import { parseAddress, badRequest } from '../validate.js';

/**
 * The client IP the per-IP cooldown is keyed on.
 *
 * In production this API only ever sees traffic through Caddy (deploy/Caddyfile), which
 * APPENDS the connecting peer to any inbound `X-Forwarded-For`. So the address Caddy
 * itself observed is the LAST entry — entries a client fabricates to look like a fresh IP
 * sit to its left and are ignored here. With no proxy in front (local dev) there is no
 * header and the socket address is used.
 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const header = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (typeof header === 'string' && header.trim()) {
    const parts = header
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Reads the request body with a hard cap — a faucet body is a single address, so a large
 * payload is either a mistake or an attempt to exhaust memory, and either way is refused. */
async function readBody(req: IncomingMessage, limitBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleFaucetWbt(req: IncomingMessage): Promise<RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return badRequest('request body too large');
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return badRequest('invalid JSON body');
  }

  const address = parseAddress((body as { address?: string })?.address);
  if (!address) return badRequest('a valid 0x address is required');

  const result = await claimWbt({ address, ip: clientIp(req) });
  if (result.ok) {
    return {
      code: 200,
      body: { ok: true, txHash: result.txHash, amountWei: result.amountWei.toString(), from: result.from },
    };
  }

  const errorBody: Record<string, unknown> = { ok: false, error: result.error };
  if (result.retryAfterSeconds != null) errorBody.retryAfterSeconds = result.retryAfterSeconds;
  return { code: result.code, body: errorBody };
}

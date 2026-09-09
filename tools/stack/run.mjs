/**
 * Boots the whole Whitespace stack in dependency order, with real readiness gating.
 *
 * Before this existed there was no way to start the system at all: five services, each
 * launched by hand, each with configuration discoverable only by reading its config
 * module. Nothing had ever run together.
 *
 * Dependency-free on purpose — same house style as `packages/metrics`. Node's own
 * child_process/http/net are enough, and a process supervisor that itself needs
 * `pnpm install` to work is a supervisor that cannot rescue a broken workspace.
 *
 * READINESS IS NOT LIVENESS. Two of the checks below deliberately read a response BODY
 * rather than a status code, because in this system a 200 does not mean healthy:
 * `services/api/src/routes/health.ts:17-20` answers 200 with `{"status":"down"}` when the
 * indexer has written no `sync_status` row at all. Gating on the status code would let a
 * completely dataless API through and push the failure downstream into the browser, which
 * is exactly the silent-success shape this codebase keeps getting caught by.
 *
 * Usage:
 *   node tools/stack/run.mjs                 # everything
 *   node tools/stack/run.mjs api indexer     # a subset, dependencies included
 *   node tools/stack/run.mjs --list
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The api's own default is 3001 (`services/api/src/server.ts:52`) but the frontend's
// default API base is 4000 (`apps/web/src/lib/config.ts:25`). Rather than leave two
// disagreeing defaults for someone to trip over at 2am, the stack pins the port here and
// hands the same number to the web app, so there is one answer inside a stack run.
const API_PORT = 4000;
const PUBLISHER_PORT = 8787;
const LIQUIDATOR_METRICS_PORT = 9464;
const INDEXER_PORT = 42069;
const WEB_PORT = 3000;

/**
 * @typedef {object} Service
 * @property {string} name
 * @property {string} cwd            relative to the repo root
 * @property {string[]} cmd
 * @property {string[]} needs        service names that must be ready first
 * @property {Record<string,string>} env
 * @property {(s: Service) => Promise<string>} ready  resolves with a human-readable detail
 */

/** @type {Service[]} */
const SERVICES = [
  {
    name: 'indexer',
    cwd: 'services/indexer',
    cmd: ['pnpm', 'exec', 'ponder', 'start', '--port', String(INDEXER_PORT)],
    needs: [],
    env: { PORT: String(INDEXER_PORT) },
    ready: () => tcpReady(INDEXER_PORT, 180_000),
  },
  {
    name: 'api',
    cwd: 'services/api',
    cmd: ['pnpm', 'exec', 'tsx', 'src/server.ts'],
    needs: ['indexer'],
    env: { PORT: String(API_PORT) },
    // Body, not status. See the header.
    ready: () =>
      jsonReady(API_PORT, '/health', 120_000, (body) => {
        if (body.status === 'down') return { ok: false, detail: 'indexer has written no sync_status row yet' };
        return { ok: true, detail: `status=${body.status} block=${body.indexedBlock} lag=${body.lagSeconds}s` };
      }),
  },
  {
    name: 'publisher',
    cwd: 'services/price-publisher',
    cmd: ['pnpm', 'start'],
    needs: [],
    env: { PUBLISHER_PORT: String(PUBLISHER_PORT) },
    // A publisher that is up but has no healthy venues signs nothing, so the keeper would
    // sit there timing out with no explanation. Surface the venue count at boot instead.
    ready: () =>
      jsonReady(PUBLISHER_PORT, '/health', 90_000, (body) => ({
        ok: true,
        detail: typeof body.venues === 'object' ? JSON.stringify(body.venues) : JSON.stringify(body),
      })),
  },
  {
    name: 'keeper',
    cwd: 'services/keeper',
    cmd: ['pnpm', 'start'],
    needs: ['publisher'],
    env: { KEEPER_PUBLISHER_URL: `http://127.0.0.1:${PUBLISHER_PORT}` },
    // The keeper is a pure watcher with no HTTP surface, so "ready" can only mean "did not
    // die on startup". Most of its failure modes (missing key file, bad RPC, unparseable
    // address) throw within the first second, so a short settle is a genuine gate rather
    // than a decorative sleep.
    ready: (s) => settled(s, 6_000),
  },
  {
    name: 'liquidator',
    cwd: 'services/liquidator',
    cmd: ['pnpm', 'start'],
    needs: ['publisher'],
    env: {
      LIQUIDATOR_PUBLISHER_URL: `http://127.0.0.1:${PUBLISHER_PORT}`,
      LIQUIDATOR_METRICS_PORT: String(LIQUIDATOR_METRICS_PORT),
    },
    ready: () => jsonReady(LIQUIDATOR_METRICS_PORT, '/health', 60_000, (body) => ({ ok: true, detail: JSON.stringify(body) })),
  },
  {
    name: 'web',
    cwd: 'apps/web',
    cmd: ['pnpm', 'exec', 'next', 'dev', '--port', String(WEB_PORT)],
    needs: ['api'],
    env: {
      NEXT_PUBLIC_API_BASE_URL: `http://localhost:${API_PORT}`,
      NEXT_PUBLIC_WS_URL: `ws://localhost:${API_PORT}/ws`,
      NEXT_PUBLIC_CHAIN_ID: '1874',
    },
    ready: () => tcpReady(WEB_PORT, 120_000),
  },
];

// ---------------------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tcpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolveOpen) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolveOpen(true); });
      socket.once('error', () => { socket.destroy(); resolveOpen(false); });
      socket.setTimeout(1000, () => { socket.destroy(); resolveOpen(false); });
    });
    if (open) return `port ${port} accepting`;
    await sleep(500);
  }
  throw new Error(`port ${port} never accepted a connection within ${timeoutMs / 1000}s`);
}

function fetchJson(port, path) {
  return new Promise((resolveJson, rejectJson) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolveJson({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { rejectJson(new Error(`non-JSON body: ${raw.slice(0, 120)}`)); }
      });
    });
    req.on('error', rejectJson);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function jsonReady(port, path, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const { status, body } = await fetchJson(port, path);
      if (status !== 200) {
        last = `HTTP ${status} ${JSON.stringify(body).slice(0, 120)}`;
      } else {
        const verdict = predicate(body);
        if (verdict.ok) return verdict.detail;
        last = verdict.detail;
      }
    } catch (err) {
      last = err.message;
    }
    await sleep(1000);
  }
  throw new Error(`${path} never became ready within ${timeoutMs / 1000}s — last: ${last}`);
}

async function settled(service, ms) {
  await sleep(ms);
  if (service.proc.exitCode !== null) {
    throw new Error(`exited with code ${service.proc.exitCode} during startup`);
  }
  return `alive after ${ms / 1000}s`;
}

// ---------------------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------------------

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[31m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const NAME_WIDTH = Math.max(...SERVICES.map((s) => s.name.length));

function log(name, color, line) {
  process.stdout.write(`${color}${name.padEnd(NAME_WIDTH)}${RESET} ${DIM}|${RESET} ${line}\n`);
}

/**
 * Minimal `.env` reader. Only `KEY=value`, `#` comments and blank lines — no interpolation,
 * no export keyword, no multiline. Anything fancier belongs in a real dotenv dependency,
 * and needing one would be a signal the config has grown too clever.
 */
function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const children = [];
let shuttingDown = false;

function start(service, color) {
  const cwd = join(REPO, service.cwd);
  const dotenv = readEnvFile(join(cwd, '.env'));

  // Precedence, weakest first: the process environment, then the service's own .env, then
  // the manifest's pins above. The manifest wins because it is what makes the parts agree
  // with each other (ports, cross-service URLs); a stale .env must not silently
  // re-introduce the port disagreement this file exists to remove.
  const env = { ...process.env, ...(dotenv ?? {}), ...service.env };

  const proc = spawn(service.cmd[0], service.cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.proc = proc;
  children.push(proc);

  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log(service.name, color, line);
    });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);

  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(service.name, color, `\x1b[31mexited code=${code} signal=${signal}${RESET}`);
  });

  log(service.name, color, `${DIM}started: ${service.cmd.join(' ')} (cwd ${service.cwd}${dotenv ? ', .env loaded' : ', no .env'})${RESET}`);
  return proc;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\nstopping…\n');
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(code);
  }, 5000).unref();
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const s of SERVICES) console.log(`${s.name.padEnd(NAME_WIDTH)}  needs: ${s.needs.join(', ') || '-'}  (${s.cwd})`);
  process.exit(0);
}

// A subset request pulls its dependencies in with it: asking for `api` without `indexer`
// would otherwise start an api whose readiness gate can never pass, and blame the api.
function withDependencies(names) {
  const wanted = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of SERVICES) {
      if (!wanted.has(s.name)) continue;
      for (const need of s.needs) if (!wanted.has(need)) { wanted.add(need); grew = true; }
    }
  }
  return SERVICES.filter((s) => wanted.has(s.name));
}

const requested = args.filter((a) => !a.startsWith('--'));
const unknown = requested.filter((r) => !SERVICES.some((s) => s.name === r));
if (unknown.length > 0) {
  console.error(`unknown service(s): ${unknown.join(', ')}. Try --list.`);
  process.exit(2);
}
const plan = requested.length > 0 ? withDependencies(requested) : SERVICES;

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const ready = new Set();
const colorOf = new Map(plan.map((s, i) => [s.name, COLORS[i % COLORS.length]]));

for (const service of plan) {
  const color = colorOf.get(service.name);
  const missing = service.needs.filter((n) => !ready.has(n));
  if (missing.length > 0) {
    log(service.name, color, `\x1b[31mskipped: dependency not ready (${missing.join(', ')})${RESET}`);
    shutdown(1);
    break;
  }

  start(service, color);
  try {
    const detail = await service.ready(service);
    ready.add(service.name);
    log(service.name, color, `\x1b[32mready${RESET} ${DIM}${detail}${RESET}`);
  } catch (err) {
    log(service.name, color, `\x1b[31mnot ready: ${err.message}${RESET}`);
    shutdown(1);
    break;
  }
}

if (!shuttingDown) {
  process.stdout.write(`\n${plan.length} service(s) up. web http://localhost:${WEB_PORT}  api http://localhost:${API_PORT}  ctrl-c to stop\n\n`);
}

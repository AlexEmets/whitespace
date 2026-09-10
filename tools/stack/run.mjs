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
//
// Each is overridable from the environment, because "the port is taken by something
// unrelated" is a normal condition on a developer machine, and the pre-flight check below
// turns it into a one-line fix (`WEB_PORT=3100 pnpm stack`) rather than a code edit.
const port = (name, fallback) => Number(process.env[name] ?? fallback);

const API_PORT = port('API_PORT', 4000);
const PUBLISHER_PORT = port('PUBLISHER_PORT', 8787);
const LIQUIDATOR_METRICS_PORT = port('LIQUIDATOR_METRICS_PORT', 9464);
const INDEXER_PORT = port('INDEXER_PORT', 42069);
const WEB_PORT = port('WEB_PORT', 3000);

/**
 * @typedef {object} Service
 * @property {string} name
 * @property {string} cwd            relative to the repo root
 * @property {string[]} cmd
 * @property {number} [port]         the port it binds, checked for collisions before boot
 * @property {string[]} needs        service names that must be ready first
 * @property {Record<string,string>} env
 * @property {(s: Service) => Promise<string>} ready  resolves with a human-readable detail
 */

/** @type {Service[]} */
const SERVICES = [
  {
    name: 'indexer',
    port: INDEXER_PORT,
    cwd: 'services/indexer',
    cmd: ['pnpm', 'exec', 'ponder', 'start', '--port', String(INDEXER_PORT)],
    needs: [],
    env: { PORT: String(INDEXER_PORT) },
    ready: () => tcpReady(INDEXER_PORT, 180_000),
  },
  {
    name: 'api',
    port: API_PORT,
    cwd: 'services/api',
    cmd: ['pnpm', 'exec', 'tsx', 'src/server.ts'],
    needs: ['indexer'],
    // The api reads the live index off the publisher (services/api/src/publisher.ts) and
    // records it as the chart's candle series, so the same port pinned below has to reach
    // it from here too — otherwise the api quietly falls back to last-trade prices.
    env: { PORT: String(API_PORT), PUBLISHER_URL: `http://127.0.0.1:${PUBLISHER_PORT}` },
    // Body, not status. See the header.
    //
    // The two ways /health says "down" need different words, because they need different
    // reactions. No `sync_status` row at all means the indexer has not committed its first
    // block — usually a configuration fault, and waiting will not help. A row that is
    // merely stale means backfill is still catching up, which is the normal state after
    // the stack has been off for a while and resolves on its own. Reporting the second as
    // the first sent a debugging session after an imaginary config problem while the
    // indexer was, in fact, working correctly at 87%.
    //
    // Hence also 600s rather than 120s: catching up several hours of chain takes minutes,
    // and a gate that gives up first turns a healthy boot into a red failure.
    ready: () =>
      jsonReady(API_PORT, '/health', 600_000, (body) => {
        // The ONLY blocking condition. No `sync_status` row means the indexer has never
        // committed a block — a configuration fault, and waiting will not fix it.
        if (body.indexedBlock === null) {
          return { ok: false, detail: 'indexer has written no sync_status row yet' };
        }
        // Lag deliberately does NOT block. The api can serve every request in this state;
        // it just serves data that is behind, and /health says so on every call. Refusing
        // to start turns a degradation into a total outage — and it did exactly that here:
        // with the indexer 4.2 h behind, the whole stack stayed down while the price feed
        // was healthy and the terminal would have worked for everything but history.
        // Loud, because stale positions on a leveraged trading screen matter.
        if (body.status !== 'ok') {
          return {
            ok: true,
            detail: `\x1b[33mSTALE\x1b[0m status=${body.status} block=${body.indexedBlock} lag=${body.lagSeconds}s — serving behind the chain head`,
          };
        }
        return { ok: true, detail: `status=${body.status} block=${body.indexedBlock} lag=${body.lagSeconds}s` };
      }),
  },
  {
    name: 'publisher',
    port: PUBLISHER_PORT,
    cwd: 'services/price-publisher',
    cmd: ['pnpm', 'start'],
    needs: [],
    env: { PUBLISHER_PORT: String(PUBLISHER_PORT) },
    // A publisher that is up but has no healthy venues signs nothing, so the keeper would
    // sit there timing out with no explanation.
    //
    // This gate used to pass unconditionally — it returned `ok: true` for whatever /health
    // said, and /health was a hardcoded `{ok:true}`. Both ends have been fixed: /health now
    // answers 503 when no feed has a live venue, jsonReady treats a non-200 as not-ready,
    // and the detail below reports the actual venue counts so a degraded-but-working boot
    // is visibly different from a dead one.
    ready: () =>
      jsonReady(PUBLISHER_PORT, '/health', 90_000, (body) => ({
        ok: body.ok === true,
        detail: `${body.feedsWithVenues ?? 0}/${body.totalFeeds ?? 0} feed(s) with a live venue ${JSON.stringify(body.feeds ?? {})}`,
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
    port: LIQUIDATOR_METRICS_PORT,
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
    port: WEB_PORT,
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

  // `detached: true` puts each service in its own process GROUP, which is what makes
  // shutdown actually work. Every command here is `pnpm …`, so the process we spawn is a
  // parent of the real one — signalling the pnpm wrapper does not propagate to its child,
  // and the service survives as an orphan still holding its port. Observed exactly that
  // with ponder: the supervisor died, `pnpm` died, ponder kept indexing and kept 42069.
  // Signalling the negated pid reaches the whole group instead.
  const proc = spawn(service.cmd[0], service.cmd.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
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

/** Signals a child's whole process group, tolerating a group that has already gone. */
function signalGroup(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone. Nothing to do, and nothing worth reporting.
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\nstopping…\n');
  for (const child of children) signalGroup(child, 'SIGTERM');

  // Deliberately NOT `.unref()`d. An unref'd timer lets Node exit as soon as the stdio
  // handles close, which is usually before this fires — so the SIGKILL escalation would
  // never run and a child that ignores SIGTERM would be left behind. Holding the loop
  // open for the grace period is the whole point of having an escalation.
  setTimeout(() => {
    for (const child of children) signalGroup(child, 'SIGKILL');
    process.exit(code);
  }, 5000);
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
// `--no-deps` starts only what was named, and treats its dependencies as already
// satisfied. For attaching one service to a stack that is already up — restarting just the
// web app against a running api, say — where pulling the dependencies in would collide
// with the instances already holding those ports.
const noDeps = args.includes('--no-deps');
const plan = requested.length === 0 ? SERVICES : noDeps ? SERVICES.filter((s) => requested.includes(s.name)) : withDependencies(requested);
const assumedReady = noDeps ? plan.flatMap((s) => s.needs) : [];

/**
 * Two pre-flight checks, both earned by a real failure rather than added defensively.
 *
 * 1. Port collisions. A developer machine may already have something on 3000. Without this
 *    the web service starts, Next silently picks the next free port, the readiness gate
 *    passes against the OTHER process, and the stack reports itself up while the browser
 *    talks to a stranger.
 *
 * 2. `.env` key coverage against `.env.example`. The examples are the documented contract
 *    with each service's config module; a `.env` missing one of their keys is a
 *    configuration hole. This check exists because a hand-written `.env` dropped
 *    `DATABASE_SCHEMA` here and Ponder died on it — the failure was loud, but only after a
 *    45-second boot, and a silent one would have been worse.
 */
async function preflight(services) {
  const problems = [];

  for (const service of services) {
    if (service.port === undefined) continue;
    const taken = await new Promise((r) => {
      const socket = connect({ port: service.port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); r(true); });
      socket.once('error', () => { socket.destroy(); r(false); });
      socket.setTimeout(700, () => { socket.destroy(); r(false); });
    });
    if (taken) problems.push(`${service.name}: port ${service.port} is already in use`);
  }

  for (const service of services) {
    const dir = join(REPO, service.cwd);
    const example = readEnvFile(join(dir, '.env.example'));
    const actual = readEnvFile(join(dir, '.env'));
    if (!example) continue;
    if (!actual) {
      // Not fatal: a service may be fully configured from the process environment.
      continue;
    }
    // A key the manifest pins is supplied by this file, so its absence from .env is fine.
    const missing = Object.keys(example).filter(
      (k) => !(k in actual) && !(k in service.env) && !(k in process.env),
    );
    if (missing.length > 0) {
      problems.push(`${service.name}: .env is missing ${missing.join(', ')} (present in .env.example)`);
    }
  }

  if (problems.length > 0) {
    console.error('\npre-flight failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(3);
  }
}

await preflight(plan);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const ready = new Set(assumedReady);
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

/**
 * Generates and installs systemd `--user` units that keep the local stack running
 * permanently — started on boot (via linger), restarted on crash (`Restart=always`), in the
 * same dependency order the hand-supervised `run.mjs` brings the stack up in.
 *
 * WHY `--user` UNITS RATHER THAN deploy/systemd. Those units target the production VPS:
 * `User=whitespace`, `/home/whitespace/whitespace`, a `docker.service` dependency. A
 * developer machine has none of that — the repo lives under `$HOME`, `node` comes from nvm,
 * there is no dedicated service account. A `--user` unit runs as the developer, reads the
 * exact same per-service `.env` files `run.mjs` reads, and needs no root beyond one
 * `loginctl enable-linger` so the units survive logout and reboot.
 *
 * WHY PER-SERVICE UNITS RATHER THAN ONE UNIT WRAPPING `run.mjs`. `run.mjs` logs a crashed
 * child and keeps running without restarting it — which is precisely the failure the trader
 * hit: the keeper was down and every order sat pending with its collateral locked. systemd
 * restarting each service on its own recovers a single crash in `RestartSec` seconds without
 * cycling the rest of the stack, and matches exactly what deploy/systemd does in production.
 *
 * The unit TEXT is produced by the pure `renderUnit` (unit-tested); the CLI only writes the
 * files and shells out to `systemctl --user`.
 *
 * Usage:
 *   node tools/stack/systemd-units.mjs --dry-run     # print the units, touch nothing
 *   node tools/stack/systemd-units.mjs install       # write, enable, start (default)
 *   node tools/stack/systemd-units.mjs uninstall     # stop, disable, remove
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_PREFIX = 'whitespace-';

/**
 * The stack the units supervise, in dependency order. This is the non-web backend plus the
 * two services the trader depends on for a fill (publisher, keeper) — the set that must be
 * up for the terminal to work. `web` is deliberately left out: `next dev` is not something
 * to hold open 24/7, and production serves the built app, not the dev server.
 *
 * `exec` tokens: `{node}` → the absolute node binary, `{repo}` → the repository root. Both
 * are resolved in `renderUnit` so the unit files carry no placeholders.
 *
 * @typedef {{ name: string, description: string, cwd: string, exec: string[],
 *   needs?: string[], memoryMax: string, preStart?: string }} UnitSpec
 * @type {UnitSpec[]}
 */
export const UNIT_SPECS = [
  {
    name: 'indexer',
    description: 'Whitespace indexer (Ponder, chain 1874 -> Postgres)',
    cwd: 'services/indexer',
    exec: ['{repo}/services/indexer/node_modules/.bin/ponder', 'start', '--port', '42069'],
    needs: [],
    memoryMax: '600M',
    // Postgres is a docker container (docker-compose.yml), not a unit. Best-effort so a
    // laptop that did not auto-start docker still comes up; `-` keeps a failure non-fatal,
    // and Restart=always retries until the database answers.
    preStart: 'cd {repo} && docker compose up -d postgres',
  },
  {
    name: 'api',
    description: 'Whitespace read API (REST + WebSocket)',
    cwd: 'services/api',
    exec: ['{repo}/services/api/node_modules/.bin/tsx', 'src/server.ts'],
    needs: ['indexer'],
    memoryMax: '350M',
  },
  {
    name: 'publisher',
    description: 'Whitespace price publisher (k-of-N signed price reports)',
    cwd: 'services/price-publisher',
    exec: ['{node}', 'src/main.mjs'],
    needs: [],
    memoryMax: '250M',
  },
  {
    name: 'keeper',
    description: 'Whitespace keeper (fulfils price requests on chain 1874)',
    cwd: 'services/keeper',
    exec: ['{node}', 'src/main.mjs'],
    needs: ['publisher'],
    memoryMax: '250M',
  },
];

/**
 * The environment the units are stamped for. Kept as an explicit argument so the render is
 * pure and testable with synthetic values.
 * @typedef {{ repo: string, home: string, nodeBinDir: string }} Ctx
 */

/** @param {Ctx} _ctx */
function unitPath(name, { home }) {
  return resolve(home, '.config/systemd/user', `${UNIT_PREFIX}${name}.service`);
}

/**
 * Render one unit file. Pure: same inputs, same bytes.
 * @param {UnitSpec} spec
 * @param {Ctx} ctx
 */
export function renderUnit(spec, ctx) {
  const { repo, home, nodeBinDir } = ctx;
  const node = resolve(nodeBinDir, 'node');
  const fill = (s) => s.replaceAll('{node}', node).replaceAll('{repo}', repo);

  const cwd = resolve(repo, spec.cwd);
  const exec = spec.exec.map(fill).join(' ');
  // nvm's node is not on the default user-unit PATH, and the ponder/tsx shebangs are
  // `#!/usr/bin/env node`, so the node bin dir must lead the PATH or they die with
  // "env: node: No such file or directory". docker (for the indexer's preStart) lives in
  // the system dirs that follow.
  const path = `${nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const after = ['network-online.target', ...(spec.needs ?? []).map((n) => `${UNIT_PREFIX}${n}.service`)];
  const wants = ['network-online.target', ...(spec.needs ?? []).map((n) => `${UNIT_PREFIX}${n}.service`)];

  const lines = [
    '[Unit]',
    `Description=${spec.description} (local dev, --user)`,
    `After=${after.join(' ')}`,
    `Wants=${wants.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${cwd}`,
    `EnvironmentFile=${cwd}/.env`,
    // HOME is not set for a unit by default; the .env.example files warn that an unset HOME
    // resolves key paths to `undefined/...` and dies with ENOENT.
    `Environment=HOME=${home}`,
    `Environment=PATH=${path}`,
  ];
  if (spec.preStart) lines.push(`ExecStartPre=-/bin/sh -c '${fill(spec.preStart)}'`);
  lines.push(
    `ExecStart=${exec}`,
    'Restart=always',
    'RestartSec=5',
    `MemoryMax=${spec.memoryMax}`,
    '',
    '[Install]',
    // default.target, not multi-user.target: a --user manager reaches default.target, and
    // with linger enabled that happens at boot without a login session.
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/** Resolve the real machine context from this process. */
export function resolveCtx() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const home = process.env.HOME;
  if (!home) throw new Error('resolveCtx: HOME is not set');
  const nodeBinDir = dirname(process.execPath);
  return { repo, home, nodeBinDir };
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const unitNames = UNIT_SPECS.map((s) => `${UNIT_PREFIX}${s.name}.service`);

function install(ctx) {
  const dir = resolve(ctx.home, '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  for (const spec of UNIT_SPECS) {
    const p = unitPath(spec.name, ctx);
    writeFileSync(p, renderUnit(spec, ctx));
    console.log(`wrote ${p}`);
  }
  run('systemctl', ['--user', 'daemon-reload']);
  // Survive logout and reboot. A user may enable their own linger without root on a default
  // Fedora polkit; if it needs privilege the command fails loudly and the note below says so.
  try {
    run('loginctl', ['enable-linger', process.env.USER ?? '']);
  } catch {
    console.warn('could not enable linger automatically — run: sudo loginctl enable-linger $USER');
  }
  run('systemctl', ['--user', 'enable', '--now', ...unitNames]);
  console.log('\ninstalled. status: systemctl --user status ' + unitNames.join(' '));
}

function uninstall(ctx) {
  try {
    run('systemctl', ['--user', 'disable', '--now', ...unitNames]);
  } catch {
    /* units may already be gone; removal below is the source of truth */
  }
  for (const spec of UNIT_SPECS) {
    const p = unitPath(spec.name, ctx);
    if (existsSync(p)) {
      rmSync(p);
      console.log(`removed ${p}`);
    }
  }
  run('systemctl', ['--user', 'daemon-reload']);
  console.log('uninstalled. (linger left enabled; disable with: loginctl disable-linger $USER)');
}

// CLI. Guarded so importing this module for tests runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2] ?? 'install';
  const ctx = resolveCtx();
  if (arg === '--dry-run' || arg === 'dry-run') {
    for (const spec of UNIT_SPECS) {
      console.log(`# ---- ${unitPath(spec.name, ctx)} ----`);
      console.log(renderUnit(spec, ctx));
    }
  } else if (arg === 'install') {
    install(ctx);
  } else if (arg === 'uninstall') {
    uninstall(ctx);
  } else {
    console.error(`unknown command: ${arg}. Use: install | uninstall | --dry-run`);
    process.exit(2);
  }
}
